//! Pairing a control with its speed sensor by trying it: the control is driven hard for a few seconds and the fan whose
//! speed rose is the one that belongs to it. Pure maths here; the recorder does the driving (`ml-recorder/src/fans.rs`).

/// The fan that answered: the one whose speed rose the most, if it rose by at least `min_rise` rpm AND clearly more than
/// every other fan (twice as much), so two fans that both drift a little never get paired by luck.
/// `before` and `after` are `(fan sensor id, rpm)`.
pub fn answering_fan(before: &[(String, f32)], after: &[(String, f32)], min_rise: f32) -> Option<(String, f32)> {
    let mut rises: Vec<(String, f32)> = after
        .iter()
        .filter_map(|(id, a)| before.iter().find(|(b, _)| b == id).map(|(_, b)| (id.clone(), a - b)))
        .collect();
    rises.sort_by(|x, y| y.1.total_cmp(&x.1));
    let (best, second) = (rises.first()?, rises.get(1).map_or(0.0, |s| s.1.max(0.0)));
    (best.1 >= min_rise && best.1 >= second * 2.0).then(|| best.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[(&str, f32)]) -> Vec<(String, f32)> {
        a.iter().map(|(k, x)| (k.to_string(), *x)).collect()
    }

    #[test]
    fn the_fan_that_rose_the_most_is_the_pair() {
        let before = v(&[("f1", 800.0), ("f2", 900.0), ("f3", 0.0)]);
        let after = v(&[("f1", 820.0), ("f2", 1500.0), ("f3", 0.0)]);
        assert_eq!(answering_fan(&before, &after, 150.0), Some(("f2".into(), 600.0)));
    }

    #[test]
    fn nothing_is_paired_when_no_fan_clearly_answered() {
        let before = v(&[("f1", 800.0), ("f2", 900.0)]);
        assert_eq!(answering_fan(&before, &v(&[("f1", 850.0), ("f2", 940.0)]), 150.0), None, "too small a rise");
        assert_eq!(answering_fan(&before, &v(&[("f1", 1200.0), ("f2", 1400.0)]), 150.0), None, "two fans rose alike: ambiguous");
        assert_eq!(answering_fan(&before, &[], 150.0), None);
        assert_eq!(answering_fan(&[], &before, 150.0), None);
    }

    #[test]
    fn a_fan_that_was_stopped_can_answer() {
        assert_eq!(answering_fan(&v(&[("f1", 0.0), ("f2", 1000.0)]), &v(&[("f1", 700.0), ("f2", 1010.0)]), 150.0), Some(("f1".into(), 700.0)));
    }
}
