/// 本地风险兜底：即使模型返回 low，也按命令内容重新评估。
pub fn assess(command: &str, model_risk: &str) -> (String, bool) {
    let lower = command.trim().to_lowercase();
    let blocked = is_hard_denied(&lower);
    let mut risk = normalize(model_risk);

    if blocked || is_high(&lower) {
        risk = "high";
    } else if is_medium(&lower) && risk == "low" {
        risk = "medium";
    }

    (risk.to_string(), blocked)
}

pub fn normalize(risk: &str) -> &'static str {
    match risk.trim().to_lowercase().as_str() {
        "low" => "low",
        "medium" | "med" | "moderate" => "medium",
        "high" | "critical" | "severe" => "high",
        _ => "medium",
    }
}

fn is_hard_denied(lower: &str) -> bool {
    if lower.contains("mkfs") || lower.contains(":(){") || lower.contains("> /dev/sda") {
        return true;
    }
    if lower.contains("dd ") && lower.contains("of=/dev/") {
        return true;
    }
    if lower.contains("shutdown")
        || lower.contains("poweroff")
        || (lower.contains("reboot") && !lower.contains("--help"))
        || lower.starts_with("init 0")
    {
        return true;
    }
    if (lower.contains("curl") || lower.contains("wget"))
        && (lower.contains("| sh") || lower.contains("| bash") || lower.contains("|sh") || lower.contains("|bash"))
    {
        return true;
    }
    if lower.contains(">") && (lower.contains("/etc/passwd") || lower.contains("/etc/shadow")) {
        return true;
    }
    if lower.contains("rm ") && (lower.contains("-rf") || lower.contains("-fr")) {
        for target in ["/", "/*", "/etc", "/usr", "/var", "/boot", "/home", "~"] {
            if lower.contains(&format!(" {target} "))
                || lower.ends_with(&format!(" {target}"))
                || lower.contains(&format!(" {target}*"))
            {
                return true;
            }
        }
    }
    false
}

fn is_high(lower: &str) -> bool {
    lower.contains("chmod -r 777")
        || lower.contains("chown -r")
        || lower.contains("iptables -f")
        || lower.contains("nft flush")
        || lower.contains("rm -rf")
        || lower.contains("userdel")
        || lower.contains("passwd ")
        || lower.contains("systemctl stop")
        || lower.contains("systemctl disable")
        || lower.contains("kill -9 1")
}

fn is_medium(lower: &str) -> bool {
    lower.contains("sudo")
        || lower.contains("systemctl restart")
        || lower.contains("kill ")
        || lower.contains("docker rm")
        || lower.contains("kubectl delete")
        || lower.contains("apt remove")
        || lower.contains("yum remove")
}
