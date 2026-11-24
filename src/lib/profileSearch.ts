import type { Profile } from "../types";

export function matchesProfile(profile: Profile, keyword: string): boolean {
  if (!keyword) return true;
  return (
    profile.name.toLowerCase().includes(keyword) ||
    profile.target.host.toLowerCase().includes(keyword) ||
    (profile.group ?? "").toLowerCase().includes(keyword) ||
    profile.protocol.includes(keyword) ||
    (profile.protocol === "rdp"
      ? "rdp 远程桌面"
      : profile.protocol === "serial"
        ? "串口 serial"
        : profile.protocol === "tunnel"
          ? "隧道 tunnel 端口转发"
          : profile.protocol === "telnet"
            ? "telnet 明文"
            : profile.protocol === "vnc"
              ? "vnc 远程桌面 rfb"
              : "ssh"
    ).includes(keyword) ||
    (profile.protocol === "tunnel"
      ? `${profile.options.tunnel?.routes.length ?? 0} 条路由`
          .toLowerCase()
          .includes(keyword)
      : false) ||
    (profile.protocol === "serial"
      ? `${profile.options.serial?.port ?? ""} ${profile.options.serial?.baud_rate ?? ""}`
          .toLowerCase()
          .includes(keyword)
      : false) ||
    profile.tags.some((tag) => tag.toLowerCase().includes(keyword))
  );
}
