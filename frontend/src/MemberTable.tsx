import {RelativeTime} from './RelativeTime';
import {exactTime} from './relative-time';
import './members.css';

export type Member = {id: string; username: string; role: string; status: string; storageBytes?: number | null; loginCount?: number; lastLoginAt?: string | null; loginStatsSince?: string};
function storage(bytes?: number | null) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '暂不可用';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
  return `${value.toLocaleString('zh-CN', {maximumFractionDigits: index ? 1 : 0})} ${units[index]}`;
}

export function MemberTable({users, currentUserId, busy, onRefresh, onToggle, onReset}: {users: Member[]; currentUserId: string; busy: boolean; onRefresh: () => void; onToggle: (user: Member) => void; onReset: (user: Member) => void}) {
  return <section className="card member-list">
    <div className="section-heading"><h2>在场的人<span className="member-count">{String(users.length).padStart(2, '0')}</span></h2><button className="member-refresh" disabled={busy} onClick={onRefresh} aria-label="刷新成员统计">刷新</button></div>
    <div className="table-scroll"><table className="members-table"><thead><tr><th scope="col">账号</th><th scope="col">角色</th><th scope="col">状态</th><th scope="col" title="当前文件大小合计，含保留版本、上传暂存及待清理文件；不含共享数据库、日志、备份和磁盘块开销。发布及清理期间可能短暂变化。">占用空间</th><th scope="col" title="只累计统计启用后的成功登录，刷新页面和登录失败均不计数。">登录次数</th><th scope="col">最近登录</th><th scope="col">操作</th></tr></thead>
      <tbody>{users.map(user => <tr key={user.id}>
        <td className="member-name" data-label="账号"><span className="table-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span><span>{user.username}</span></td>
        <td data-label="角色">{user.role === 'admin' ? '管理员' : '成员'}</td>
        <td data-label="状态"><span className={'badge ' + (user.status === 'active' ? 'published' : '')}>{user.status === 'active' ? '正常' : '已停用'}</span></td>
        <td data-label="占用空间" className="member-number" title={user.storageBytes == null ? '暂时无法读取占用空间，请刷新重试' : `${user.storageBytes.toLocaleString('zh-CN')} 字节（包含保留版本及待清理文件）`}>{storage(user.storageBytes)}</td>
        <td data-label="登录次数" className="member-number" title={user.loginStatsSince ? `自 ${exactTime(user.loginStatsSince)} 起累计成功登录；此前未记录` : '仅统计成功登录'}>{user.loginCount == null ? '—' : `${user.loginCount.toLocaleString('zh-CN')} 次`}</td>
        <td data-label="最近登录" className="member-last-login">{user.lastLoginAt ? <RelativeTime value={user.lastLoginAt}/> : <span className="muted">暂无记录</span>}</td>
        <td data-label="操作" className="member-actions">{user.id !== currentUserId && user.role !== 'admin' ? <><button disabled={busy} onClick={() => onToggle(user)}>{user.status === 'active' ? '停用' : '启用'}</button><button disabled={busy} onClick={() => onReset(user)}>重置密码</button></> : <span className="muted">—</span>}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="member-stats-note">登录数据自统计启用后累计。</p>
  </section>;
}
