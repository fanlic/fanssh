import { useMemo, useState } from "react";
import { errorText, profileDelete } from "../api";
import { useAppStore } from "../store";
import type { Profile } from "../types";

interface Props {
  onNew: () => void;
  onEdit: (profile: Profile) => void;
  onImport: () => void;
  onExport: () => void;
  onRdp: (profile: Profile) => void;
  onNotice: (message: string, kind?: "info" | "error") => void;
}

export function SessionSidebar({ onNew, onEdit, onImport, onExport, onRdp, onNotice }: Props) {
  const profiles = useAppStore((s) => s.profiles);
  const loading = useAppStore((s) => s.profilesLoading);
  const error = useAppStore((s) => s.profilesError);
  const openProfileTab = useAppStore((s) => s.openProfileTab);
  const setSftpProfileId = useAppStore((s) => s.setSftpProfileId);
  const loadProfiles = useAppStore((s) => s.loadProfiles);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    const visible = profiles.filter((profile) => {
      if (!keyword) return true;
      return (
        profile.name.toLowerCase().includes(keyword) ||
        profile.target.host.toLowerCase().includes(keyword) ||
        profile.tags.some((tag) => tag.toLowerCase().includes(keyword))
      );
    });
    const map = new Map<string, Profile[]>();
    for (const profile of visible) {
      const key = profile.group?.trim() || "未分组";
      const list = map.get(key) ?? [];
      list.push(profile);
      map.set(key, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [profiles, filter]);

  const handleConnect = (profile: Profile) => {
    if (profile.protocol === "rdp") {
      onRdp(profile);
    } else {
      openProfileTab(profile);
    }
  };

  const handleDelete = async (profile: Profile) => {
    if (!window.confirm(`确定删除「${profile.name}」？关联的凭据也会一并清理。`)) return;
    try {
      await profileDelete(profile.id);
      await loadProfiles();
      onNotice(`已删除 ${profile.name}`);
    } catch (err) {
      onNotice(errorText(err), "error");
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">FanSSH</span>
        <span className="badge">v1</span>
      </div>
      <div className="sidebar-tools">
        <input
          className="search"
          placeholder="搜索名称 / 主机 / 标签"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="tool-row">
          <button className="primary small" onClick={onNew}>
            + 新建连接
          </button>
          <button className="ghost small" onClick={onImport} title="从 JSON 导入">
            导入
          </button>
          <button className="ghost small" onClick={onExport} title="导出为 JSON">
            导出
          </button>
        </div>
      </div>

      <div className="sidebar-list">
        {loading && <div className="hint">加载中…</div>}
        {error && <div className="hint error">{error}</div>}
        {!loading && !error && profiles.length === 0 && (
          <div className="hint">
            还没有服务器配置。
            <br />
            点「新建连接」添加第一台服务器。
          </div>
        )}
        {groups.map(([group, list]) => {
          const isCollapsed = collapsed[group] ?? false;
          return (
            <div className="group" key={group}>
              <button
                className="group-head"
                onClick={() => setCollapsed((prev) => ({ ...prev, [group]: !isCollapsed }))}
              >
                <span className={`caret${isCollapsed ? " collapsed" : ""}`}>▾</span>
                <span>{group}</span>
                <span className="group-count">{list.length}</span>
              </button>
              {!isCollapsed &&
                list.map((profile) => (
                  <div
                    key={profile.id}
                    className="session-item"
                    onDoubleClick={() => handleConnect(profile)}
                    title={`双击连接 ${profile.target.user}@${profile.target.host}`}
                  >
                    <span className={`proto proto-${profile.protocol}`}>
                      {profile.protocol === "rdp" ? "RDP" : "SSH"}
                    </span>
                    <div className="session-main">
                      <div className="session-name">{profile.name}</div>
                      <div className="session-sub">
                        {profile.target.user ? `${profile.target.user}@` : ""}
                        {profile.target.host}:{profile.target.port}
                        {profile.jump.length > 0 && <span className="tag">跳板</span>}
                        {profile.tags.map((tag) => (
                          <span className="tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="session-actions">
                      <button className="icon" title="连接" onClick={() => handleConnect(profile)}>
                        ▶
                      </button>
                      {profile.protocol === "ssh" && (
                        <button
                          className="icon"
                          title="SFTP 文件"
                          onClick={() => setSftpProfileId(profile.id)}
                        >
                          ⇅
                        </button>
                      )}
                      <button className="icon" title="编辑" onClick={() => onEdit(profile)}>
                        ✎
                      </button>
                      <button className="icon danger" title="删除" onClick={() => handleDelete(profile)}>
                        🗑
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
      <div className="sidebar-foot">
        <span>{profiles.length} 个配置</span>
        <span>配置与凭据分开存储</span>
      </div>
    </aside>
  );
}
