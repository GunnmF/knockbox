//! 模糊匹配与排序。
//!
//! 这是启动器"手感"的核心：用户敲下 `sl` 期望 Safari 而不是别的。
//! 打分策略按直觉分层，从最精确的匹配一路退化到最宽松的子序列匹配。

/// 对 `query` 与 `text` 打分。`None` 表示完全不匹配。
///
/// 分数区间大致是 `[0, 1000]`，可直接跨候选项比较。
pub fn score(query: &str, text: &str) -> Option<f64> {
    let q: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).collect();
    if q.is_empty() {
        // 空查询时给一个中性分，让调用方按自身默认顺序展示
        return Some(0.5);
    }
    let lq: Vec<char> = query.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    let lt: Vec<char> = text.to_lowercase().chars().collect();
    if lt.is_empty() {
        return None;
    }

    // 长度惩罚：同名候选中短的更相关
    let len_penalty = (lt.len() as f64 - lq.len() as f64).max(0.0) * 0.35;

    // 1. 完全相等
    if lt == lq {
        return Some(1000.0 - len_penalty);
    }

    // 2. 前缀匹配 —— 敲缩写命中应用名开头
    if lt.starts_with(&lq) {
        let coverage = lq.len() as f64 / lt.len() as f64;
        return Some(820.0 + 80.0 * coverage - len_penalty);
    }

    // 3. 子串匹配
    if let Some(pos) = find_subsequence_pos(&lt, &lq) {
        let coverage = lq.len() as f64 / lt.len() as f64;
        let position_penalty = (pos as f64) * 1.5;
        return Some(600.0 + 100.0 * coverage - position_penalty - len_penalty);
    }

    // 4. 子序列匹配（acronym 式），逐字对齐并给边界加权
    let raw: Vec<char> = text.chars().collect();
    let mut idx = 0usize;
    let mut base = 240.0_f64;
    let mut bonus = 0.0_f64;
    let mut last_matched: Option<usize> = None;

    for (i, &ch) in lt.iter().enumerate() {
        if idx < lq.len() && ch == lq[idx] {
            // 词首 / 驼峰边界加权：敲 `sm` 应该命中 `Safari Mail` 而非 `Samba`
            if i == 0 || is_boundary(&raw, i) {
                bonus += 45.0;
            }
            // 连续命中额外加权
            if let Some(prev) = last_matched {
                if prev + 1 == i {
                    bonus += 25.0;
                }
            }
            base -= (i as f64) * 0.8; // 越靠后越不相关
            last_matched = Some(i);
            idx += 1;
            if idx == lq.len() {
                break;
            }
        }
    }

    if idx < lq.len() {
        return None; // 不是子序列
    }
    let coverage = lq.len() as f64 / lt.len() as f64;
    Some((base + bonus + 40.0 * coverage - len_penalty).max(1.0))
}

/// 找子序列匹配的**最早**起始位置，用于给"靠前的子串"更高分。
fn find_subsequence_pos(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    let first = needle[0];
    for start in 0..hay.len() {
        if hay[start] != first {
            continue;
        }
        let mut i = start;
        let mut j = 1;
        while i < hay.len() && j < needle.len() {
            if hay[i] == needle[j] {
                j += 1;
            }
            i += 1;
        }
        if j == needle.len() {
            return Some(start);
        }
    }
    None
}

/// 判断 `i` 处是否是词的起点（分隔符后、或驼峰大写字母）。
fn is_boundary(raw: &[char], i: usize) -> bool {
    if i == 0 {
        return true;
    }
    let prev = raw[i - 1];
    if !prev.is_alphanumeric() {
        return true; // `-`, `_`, ` `, `.`, `/` 之后
    }
    // 驼峰边界：前一位小写、当前位大写
    let cur = raw[i];
    prev.is_lowercase() && cur.is_uppercase()
}

/// 对一组候选项打分并排序，只保留 `limit` 条。
pub fn rank(mut items: Vec<Scored>, limit: usize) -> Vec<Scored> {
    items.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.title.cmp(&b.0.title))
    });
    items.truncate(limit);
    items
}

use super::ResultItem;

pub type Scored = (ResultItem, f64);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 前缀匹配优先于子序列匹配() {
        let prefix = score("saf", "Safari").unwrap();
        let subseq = score("saf", "Sublime Text Editor").unwrap_or(0.0);
        assert!(prefix > subseq);
    }

    #[test]
    fn 缩写能命中驼峰名() {
        assert!(score("vs", "VS Code").is_some());
        assert!(score("st", "Sublime Text").is_some());
    }

    #[test]
    fn 无关词不匹配() {
        assert!(score("zzz", "Safari").is_none());
    }

    #[test]
    fn 短名比长名得分高() {
        let short = score("note", "Note").unwrap();
        let long = score("note", "Notepad Plus Plus Enterprise").unwrap_or(0.0);
        assert!(short > long);
    }
}