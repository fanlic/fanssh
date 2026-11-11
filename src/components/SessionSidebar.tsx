import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, profileDelete } from "../api";
import { useAppStore } from "../store";
import type { Profile } from "../types";
import { Icon } from "./Icon";

interface Props {
  onNew: () => void;
  onEdit: (profile: Profile) => void;
  onImport: () => void;
  onExport: () => void;
  onRdp: (profile: Profile) => void;
  onNotice: (message: string, kind?: "info" | "error") => void;
  focusSignal: number;
}

type ProtoFilter = "ssh" | "rdp";

const PROTO_LABEL: Record<ProtoFilter, string> = { ssh: "SSH", rdp: "RDP" };

export function SessionSidebar({
  onNew,
  onEdit,
  onImport,
  onExport,
  onRdp,
  onNotice,
  focusSignal,
}: Props) {
  const profiles = useAppStore((s) => s.profiles);
  const loading = useAppStore((s) => s.profilesLoading);
  const error = useAppStore((s) => s.profilesError);
  const tabs = useAppStore((s) => s.tabs);
  const openProfileTab = useAppStore((s) => s.openProfileTab);
  const setSftpProfileId = useAppStore((s) => s.setSftpProfileId);
  const loadProfiles = useAppStore((s) => s.loadProfiles);

  const [filter, setFilter] = useState("");
  const [proto, setProto] = useState<ProtoFilter>("ssh");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSignal > 0) searchRef.current?.focus();
  }, [focusSignal]);

  const keyword = filter.trim().toLowerCase();
  const matches = useMemo(
    () =>
      profiles.filter((profile) => {
        if (!keyword) return true;
        return (
          profile.name.toLowerCase().includes(keyword) ||
          profile.target.host.toLowerCase().includes(keyword) ||
          (profile.group ?? "").toLowerCase().includes(keyword) ||
          profile.protocol.includes(keyword) ||
          (profile.protocol === "rdp" ? "rdp 远程桌面" : "ssh").includes(keyword) ||
          profile.tags.some((tag) => tag.toLowerCase().includes(keyword))
        );
      }),
    [profiles, keyword],
  );

  const globalCount = useMemo(
    () => ({
      ssh: profiles.filter((profile) => profile.protocol === "ssh").length,
      rdp: profiles.filter((profile) => profile.protocol === "rdp").length,
    }),
    [profiles],
  );
  const matchCount = useMemo(
    () => ({
      ssh: matches.filter((profile) => profile.protocol === "ssh").length,
      rdp: matches.filter((profile) => profile.protocol === "rdp").length,
    }),
    [matches],
  );

  const groups = useMemo(() => {
    const visible = matches.filter((profile) => profile.protocol === proto);
    const map = new Map<string, Profile[]>();
    for (const profile of visible) {
      const key = profile.group?.trim() || "未分组";
      const list = map.get(key) ?? [];
      list.push(profile);
      map.set(key, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [matches, proto]);

  const activeProfileIds = useMemo(
    () => new Set(tabs.flatMap((tab) => tab.panes.map((pane) => pane.profileId))),
    [tabs],
  );

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

  const visibleCount = groups.reduce((sum, [, list]) => sum + list.length, 0);
  const emptyVariant: "none" | "search" | "protocol" | null =
    profiles.length === 0
      ? "none"
      : visibleCount > 0 || loading || error
        ? null
        : keyword
          ? "search"
          : "protocol";

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <span className="sb-title">会话</span>
        <span className="sb-count">{profiles.length}</span>
        <div className="spacer" />
        <button className="icon-btn sm" title="新建连接" onClick={onNew}>
          <Icon name="plus" size={14} />
        </button>
      </div>

      <div className="sb-search">
        <Icon name="search" size={13} />
        <input
          ref={searchRef}
          value={filter}
          placeholder="搜索名称 / 主机 / 标签"
          onChange={(event) => setFilter(event.target.value)}
        />
        {filter ? (
          <button className="sb-clear" title="清空" onClick={() => setFilter("")}>
            <Icon name="x" size={11} />
          </button>
        ) : (
          <kbd>/</kbd>
        )}
      </div>

      <div className="sb-actions">
        <button className="btn-primary" onClick={onNew}>
          <Icon name="plus" size={13} />
          新建连接
        </button>
        <button className="btn-ghost" title="从 JSON 导入" onClick={onImport}>
          <Icon name="import" size={13} />
          导入
        </button>
        <button className="icon-btn sm" title="导出为 JSON" onClick={onExport}>
          <Icon name="export" size={14} />
        </button>
      </div>

      <div className="sb-list">
        {loading && <div className="sb-hint">加载中…</div>}
        {error && <div className="sb-hint err">{error}</div>}
        {groups.map(([group, list]) => {
          const isCollapsed = collapsed[group] ?? false;
          return (
            <div className="group" key={group}>
              <button
                className={`group-head${isCollapsed ? " is-collapsed" : ""}`}
                onClick={() => setCollapsed((prev) => ({ ...prev, [group]: !isCollapsed }))}
              >
                <Icon name="chev" size={11} className="g-caret" />
                <span className="g-name">{group}</span>
                <span className="g-count">{list.length}</span>
              </button>
              {!isCollapsed &&
                list.map((profile) => (
                  <div
                    key={profile.id}
                    className={`session${activeProfileIds.has(profile.id) ? " is-open" : ""}`}
                    onDoubleClick={() => handleConnect(profile)}
                    title={`双击连接 ${profile.target.user ? `${profile.target.user}@` : ""}${profile.target.host}:${profile.target.port}`}
                  >
                    <span className={`proto-tag ${profile.protocol}`}>
                      {PROTO_LABEL[profile.protocol]}
                    </span>
                    <span className="s-name">{profile.name}</span>
                    <span className="s-host">{profile.target.host}</span>
                    <span className={`s-dot ${activeProfileIds.has(profile.id) ? "on" : ""}`} />
                    <div className="s-actions">
                      <button className="mini" title="连接" onClick={() => handleConnect(profile)}>
                        <Icon name="play" size={12} />
                      </button>
                      {profile.protocol === "ssh" && (
                        <button
                          className="mini"
                          title="SFTP 文件"
                          onClick={() => setSftpProfileId(profile.id)}
                        >
                          <Icon name="transfer" size={12} />
                        </button>
                      )}
                      <button className="mini" title="编辑" onClick={() => onEdit(profile)}>
                        <Icon name="edit" size={12} />
                      </button>
                      <button
                        className="mini danger"
                        title="删除"
                        onClick={() => handleDelete(profile)}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          );
        })}

        {emptyVariant === "none" && (
          <div className="sb-empty">
            <span className="empty-icon">
              <Icon name="folder" size={18} />
            </span>
            <div className="empty-title">还没有服务器配置</div>
            <div className="empty-desc">添加第一台 SSH / RDP 服务器后即可双击连接</div>
            <button className="btn-primary sm" onClick={onNew}>
              新建连接
            </button>
          </div>
        )}
        {emptyVariant === "search" && (
          <div className="sb-empty">
            <span className="empty-icon">
              <Icon name="search" size={18} />
            </span>
            <div className="empty-title">没有匹配的会话</div>
            <div className="empty-desc">试试更短的关键词，或切换协议</div>
            <button className="btn-ghost sm" onClick={() => setFilter("")}>
              清除搜索
            </button>
          </div>
        )}
        {emptyVariant === "protocol" && (
          <div className="sb-empty">
            <span className="empty-icon">
              <Icon name="plus" size={18} />
            </span>
            <div className="empty-title">该协议下没有配置</div>
            <div className="empty-desc">
              当前没有 {PROTO_LABEL[proto]} 会话
            </div>
            <button className="btn-ghost sm" onClick={onNew}>
              新建 {PROTO_LABEL[proto]} 连接
            </button>
          </div>
        )}
      </div>

      <div className="sb-filter" role="tablist" aria-label="协议筛选">
        <div className="proto-switch">
          {(["ssh", "rdp"] as ProtoFilter[]).map((item) => {
            const disabled = globalCount[item] === 0;
            return (
              <button
                key={item}
                role="tab"
                aria-selected={proto === item}
                className={`proto-tab${proto === item ? " is-active" : ""}`}
                disabled={disabled}
                title={disabled ? `暂无 ${PROTO_LABEL[item]} 配置` : `只看 ${PROTO_LABEL[item]}`}
                onClick={() => setProto(item)}
              >
                {PROTO_LABEL[item]}
                <span className="pcount">{matchCount[item]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="sb-foot">
        <Icon name="lock" size={11} />
        <span>凭据已加密，与配置分开存储</span>
      </div>
    </aside>
  );
}
