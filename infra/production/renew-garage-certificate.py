#!/www/server/panel/pyenv/bin/python3
"""Renew only garage.byjin.cn; install only after reviewing actual panel order schema.

Run as root. Logs may contain ACME response data: keep the dedicated directory private.
Never call the panel's unfiltered --renew without an explicitly verified order index.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

DOMAIN = 'garage.byjin.cn'
PANEL = Path('/www/server/panel')
CERT = PANEL / 'vhost/letsencrypt' / DOMAIN / 'fullchain.pem'
KEY = CERT.with_name('privkey.pem')
PYTHON = PANEL / 'pyenv/bin/python3'
NGINX = Path('/www/server/nginx/sbin/nginx')
STATE = Path('/opt/garage-publisher/certificate-renewal')
SECONDS = 30 * 24 * 3600


def command(args):
    result = subprocess.run([str(a) for a in args], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=60)
    if result.returncode:
        raise RuntimeError('Certificate validation command failed: ' + str(args[0]))
    return result.stdout


def info():
    sans = command(['openssl', 'x509', '-in', CERT, '-noout', '-ext', 'subjectAltName']).decode()
    if re.findall(r'DNS:([^,\s]+)', sans) != [DOMAIN]:
        raise RuntimeError('Refusing certificate whose DNS SAN is not exactly ' + DOMAIN)
    # Ignore no other SAN types: this certificate must belong only to this domain.
    if re.search(r'IP Address:|URI:|email:', sans):
        raise RuntimeError('Unexpected extra SAN type')
    not_after = command(['openssl', 'x509', '-in', CERT, '-noout', '-enddate']).decode().strip()
    expiry = datetime.datetime.strptime(not_after.split('=', 1)[1], '%b %d %H:%M:%S %Y %Z')
    pub = command(['openssl', 'x509', '-in', CERT, '-noout', '-pubkey'])
    key_pub = command(['openssl', 'pkey', '-in', KEY, '-pubout'])
    if pub.strip() != key_pub.strip():
        raise RuntimeError('Certificate and private key do not match')
    der = command(['openssl', 'x509', '-in', CERT, '-outform', 'DER'])
    return expiry, hashlib.sha256(der).hexdigest()


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run this dedicated renewal helper as root')
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / 'renew.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Garage certificate renewal already running; skipped')
            return
        expiry, previous = info()
        check = subprocess.run(['openssl', 'x509', '-in', str(CERT), '-checkend', str(SECONDS), '-noout'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        check_only = sys.argv[1:] == ['--check']
        if sys.argv[1:] and not check_only:
            raise RuntimeError('Only optional --check is supported')
        if check.returncode == 0 and not check_only:
            print('Garage certificate remains valid beyond 30 days; no changes')
            return

        # The deployed panel's renew_cert(index, cycle) is verified to target one order.
        # Select only a unique existing garage-only order; never invoke unfiltered renewal.
        order_index = os.environ.get('GARAGE_ACME_ORDER_INDEX', '')
        config_path = Path(os.environ.get('GARAGE_ACME_CONFIG', str(PANEL / 'config/letsencrypt_v2.json')))
        with config_path.open() as source:
            config = json.load(source)
        def output_path(order):
            value = order.get('save_path', '')
            location = Path(value)
            return (location if location.is_absolute() else PANEL / location).resolve() if value else None
        if not order_index:
            matches = [index for index, item in config.get('orders', {}).items()
                       if isinstance(item, dict) and item.get('domains') == [DOMAIN]
                       and output_path(item) == CERT.parent.resolve()]
            if len(matches) != 1:
                raise RuntimeError('Expected exactly one existing garage-only ACME order')
            order_index = matches[0]
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', order_index):
            raise RuntimeError('Invalid garage order index')
        order = config.get('orders', {}).get(order_index)
        if not isinstance(order, dict) or order.get('domains') != [DOMAIN]:
            raise RuntimeError('Selected order must contain domains=[garage.byjin.cn] exactly; verify panel schema')
        if output_path(order) != CERT.parent.resolve():
            raise RuntimeError('Selected order output directory does not match the live garage certificate')
        if order.get('auth_type') != 'http':
            raise RuntimeError('Selected order must use HTTP webroot validation')
        if Path(order.get('auth_to', '')).resolve() != Path('/www/wwwroot/garage.byjin.cn'):
            raise RuntimeError('Selected order must use the garage-only HTTP webroot')
        if check_only:
            print('Garage certificate, key and unique HTTP order validated; check-only, no renewal or reload')
            return

        log = STATE / ('renew-' + datetime.datetime.utcnow().strftime('%Y%m%d-%H%M%S') + '.log')
        environment = dict(os.environ, PYTHONPATH=str(PANEL))
        with log.open('xb') as output:
            result = subprocess.run([str(PYTHON), 'class/acme_v2.py', '--renew=1',
                                     '--index=' + order_index, '--cycle=31'], cwd=str(PANEL),
                                    env=environment, stdout=output, stderr=subprocess.STDOUT, timeout=900)
        if result.returncode:
            raise RuntimeError('Garage-only renewal command failed; inspect the private renewal log')
        new_expiry, current = info()
        if current == previous or new_expiry <= expiry:
            raise RuntimeError('No renewed garage certificate with a later expiry; refusing Nginx reload')
        command([NGINX, '-t'])
        command([NGINX, '-s', 'reload'])
        print('Garage-only certificate renewed and validated; Nginx reloaded')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Garage certificate renewal failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
