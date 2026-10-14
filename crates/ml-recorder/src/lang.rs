//! Text shown by the recorder itself (tray menu, tooltip, popups, errors). The UI language comes from
//! `recorder.json` (`lang`, written by the app); unknown codes fall back to English.
//! Column order of every row: en, pl, de, es, fr, uk, tr, ja, zh. Placeholders look like `{n}`.

use std::sync::RwLock;

const CODES: [&str; 9] = ["en", "pl", "de", "es", "fr", "uk", "tr", "ja", "zh"];

static LANG: RwLock<usize> = RwLock::new(0);

/// Sets the language for all later lookups (call after every config load/reload).
pub fn set(code: &str) {
    let i = CODES.iter().position(|c| *c == code).unwrap_or(0);
    *LANG.write().unwrap() = i;
}

/// Looks `key` up in the current language; the key itself is returned when it is unknown.
pub fn t(key: &str) -> String {
    let i = *LANG.read().unwrap();
    TABLE
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v[i].to_string())
        .unwrap_or_else(|| key.to_string())
}

/// Like [`t`], then replaces `{name}` placeholders with the given values.
pub fn f(key: &str, vars: &[(&str, &dyn std::fmt::Display)]) -> String {
    let mut s = t(key);
    for (name, v) in vars {
        s = s.replace(&format!("{{{name}}}"), &v.to_string());
    }
    s
}

#[rustfmt::skip]
static TABLE: &[(&str, [&str; 9])] = &[
    ("tip.saved", ["Buffer — clip saved", "Buffer — klip zapisany", "Buffer — Clip gespeichert", "Buffer — clip guardado", "Buffer — clip enregistré", "Buffer — кліп збережено", "Buffer — klip kaydedildi", "Buffer — クリップを保存しました", "Buffer — 片段已保存"]),
    ("tip.save_failed", ["Buffer — couldn't save the clip", "Buffer — nie udało się zapisać klipu", "Buffer — Clip konnte nicht gespeichert werden", "Buffer — no se pudo guardar el clip", "Buffer — échec de l'enregistrement du clip", "Buffer — не вдалося зберегти кліп", "Buffer — klip kaydedilemedi", "Buffer — クリップを保存できませんでした", "Buffer — 无法保存片段"]),
    ("tip.postroll", ["Buffer — saving clip in {n} s (press again = now)", "Buffer — zapis klipu za {n} s (skrót ponownie = od razu)", "Buffer — Clip wird in {n} s gespeichert (nochmal drücken = sofort)", "Buffer — guardando el clip en {n} s (pulsa otra vez = ya)", "Buffer — clip enregistré dans {n} s (réappuyer = tout de suite)", "Buffer — збереження кліпу за {n} с (натисніть ще раз = одразу)", "Buffer — klip {n} sn içinde kaydedilecek (tekrar bas = hemen)", "Buffer — {n} 秒後にクリップを保存（もう一度押すと即保存）", "Buffer — {n} 秒后保存片段（再按一次立即保存）"]),
    ("tip.finalizing", ["Buffer — finishing recording…", "Buffer — kończę zapis nagrania…", "Buffer — Aufnahme wird abgeschlossen…", "Buffer — terminando la grabación…", "Buffer — fin de l'enregistrement…", "Buffer — завершую запис…", "Buffer — kayıt tamamlanıyor…", "Buffer — 録画を終了しています…", "Buffer — 正在结束录制…"]),
    ("tip.longrec", ["Buffer — recording everything · {t}", "Buffer — nagrywa całość · {t}", "Buffer — alles wird aufgenommen · {t}", "Buffer — grabando todo · {t}", "Buffer — enregistre tout · {t}", "Buffer — записую все · {t}", "Buffer — her şeyi kaydediyor · {t}", "Buffer — すべて録画中 · {t}", "Buffer — 正在录制全部 · {t}"]),
    ("tip.idle", ["Buffer — waiting for a game (records games only)", "Buffer — czeka na grę (nagrywa tylko gry)", "Buffer — wartet auf ein Spiel (nur Spiele)", "Buffer — esperando un juego (solo juegos)", "Buffer — attend un jeu (jeux seulement)", "Buffer — чекає на гру (лише ігри)", "Buffer — oyun bekliyor (yalnızca oyunlar)", "Buffer — ゲーム待機中（ゲームのみ録画）", "Buffer — 等待游戏（仅录制游戏）"]),
    ("tip.starting", ["Buffer — starting recording…", "Buffer — uruchamianie nagrywania…", "Buffer — Aufnahme startet…", "Buffer — iniciando la grabación…", "Buffer — démarrage de l'enregistrement…", "Buffer — запуск запису…", "Buffer — kayıt başlıyor…", "Buffer — 録画を開始しています…", "Buffer — 正在启动录制…"]),
    ("tip.stopped", ["Buffer — not recording: {msg}", "Buffer — nie nagrywa: {msg}", "Buffer — keine Aufnahme: {msg}", "Buffer — no graba: {msg}", "Buffer — n'enregistre pas : {msg}", "Buffer — не записує: {msg}", "Buffer — kaydetmiyor: {msg}", "Buffer — 録画していません: {msg}", "Buffer — 未录制：{msg}"]),
    ("word.stopped", ["stopped", "zatrzymane", "gestoppt", "detenida", "arrêté", "зупинено", "durduruldu", "停止中", "已停止"]),
    ("tip.problem", ["Buffer — check: not working: {list}", "Buffer — uwaga, nie działa: {list}", "Buffer — Achtung, funktioniert nicht: {list}", "Buffer — atención, no funciona: {list}", "Buffer — attention, ne marche pas : {list}", "Buffer — увага, не працює: {list}", "Buffer — dikkat, çalışmıyor: {list}", "Buffer — 注意: 動作していません: {list}", "Buffer — 注意：无法工作：{list}"]),
    ("tip.recording", ["Buffer — recording · buffer {cur}/{max} s{game}", "Buffer — nagrywa · bufor {cur}/{max} s{game}", "Buffer — nimmt auf · Puffer {cur}/{max} s{game}", "Buffer — grabando · búfer {cur}/{max} s{game}", "Buffer — enregistre · tampon {cur}/{max} s{game}", "Buffer — записує · буфер {cur}/{max} с{game}", "Buffer — kaydediyor · arabellek {cur}/{max} sn{game}", "Buffer — 録画中 · バッファ {cur}/{max} 秒{game}", "Buffer — 录制中 · 缓冲 {cur}/{max} 秒{game}"]),
    ("src.Game", ["game audio", "dźwięk gry", "Spielton", "audio del juego", "son du jeu", "звук гри", "oyun sesi", "ゲーム音声", "游戏音频"]),
    ("src.Chat", ["chat", "czat", "Sprachchat", "chat de voz", "chat vocal", "голосовий чат", "sesli sohbet", "ボイスチャット", "语音聊天"]),
    ("src.Mic", ["microphone", "mikrofon", "Mikrofon", "micrófono", "microphone", "мікрофон", "mikrofon", "マイク", "麦克风"]),
    ("pop.postroll", ["Saving clip in {n} s", "Zapisuję klip za {n} s", "Clip wird in {n} s gespeichert", "Guardando el clip en {n} s", "Clip enregistré dans {n} s", "Збереження кліпу за {n} с", "Klip {n} sn içinde kaydedilecek", "{n} 秒後にクリップを保存", "{n} 秒后保存片段"]),
    ("pop.postroll_sub", ["Press the shortcut again to save now", "Naciśnij skrót ponownie, aby zapisać od razu", "Kürzel nochmal drücken, um sofort zu speichern", "Pulsa el atajo otra vez para guardar ya", "Réappuyez sur le raccourci pour enregistrer tout de suite", "Натисніть скорочення ще раз, щоб зберегти одразу", "Hemen kaydetmek için kısayola tekrar bas", "もう一度ショートカットを押すと即保存します", "再按一次快捷键即可立即保存"]),
    ("pop.save_failed", ["Couldn't save the clip", "Nie udało się zapisać klipu", "Clip konnte nicht gespeichert werden", "No se pudo guardar el clip", "Échec de l'enregistrement du clip", "Не вдалося зберегти кліп", "Klip kaydedilemedi", "クリップを保存できませんでした", "无法保存片段"]),
    ("pop.saved", ["Clip saved", "Zapisano klip", "Clip gespeichert", "Clip guardado", "Clip enregistré", "Кліп збережено", "Klip kaydedildi", "クリップを保存しました", "片段已保存"]),
    ("pop.active", ["Buffer active", "Buffer aktywny", "Buffer aktiv", "Buffer activo", "Buffer actif", "Buffer активний", "Buffer etkin", "Buffer 動作中", "Buffer 已启用"]),
    ("pop.active_sub", ["{hk} — save the last {len} · {game}", "{hk} — zapisz ostatnie {len} · {game}", "{hk} — letzte {len} speichern · {game}", "{hk} — guardar los últimos {len} · {game}", "{hk} — enregistrer les {len} dernières · {game}", "{hk} — зберегти останні {len} · {game}", "{hk} — son {len} kaydedilir · {game}", "{hk} — 直近 {len} を保存 · {game}", "{hk} — 保存最近 {len} · {game}"]),
    ("pop.down", ["{game}: recording isn't working", "{game}: nagrywanie nie działa", "{game}: Aufnahme funktioniert nicht", "{game}: la grabación no funciona", "{game} : l'enregistrement ne marche pas", "{game}: запис не працює", "{game}: kayıt çalışmıyor", "{game}: 録画が動作していません", "{game}：录制无法工作"]),
    ("pop.down_sub", ["Open Buffer → Settings → Recording", "Otwórz Buffer → Ustawienia → Nagrywanie", "Buffer öffnen → Einstellungen → Aufnahme", "Abre Buffer → Ajustes → Grabación", "Ouvrez Buffer → Réglages → Enregistrement", "Відкрийте Buffer → Параметри → Запис", "Buffer → Ayarlar → Kayıt bölümünü açın", "Buffer → 設定 → 録画 を開いてください", "打开 Buffer → 设置 → 录制"]),
    ("pop.warn", ["Buffer active, but check", "Buffer aktywny, ale uwaga", "Buffer aktiv, aber Achtung", "Buffer activo, pero revisa", "Buffer actif, mais attention", "Buffer активний, але є проблема", "Buffer etkin, ama dikkat", "Buffer は動作中ですが注意", "Buffer 已启用，但需注意"]),
    ("pop.warn_sub", ["Not working: {list} · {hk} saves a clip", "Nie działa: {list} · {hk} zapisuje klip", "Funktioniert nicht: {list} · {hk} speichert einen Clip", "No funciona: {list} · {hk} guarda un clip", "Ne marche pas : {list} · {hk} enregistre un clip", "Не працює: {list} · {hk} зберігає кліп", "Çalışmıyor: {list} · {hk} klip kaydeder", "動作していません: {list} · {hk} でクリップ保存", "无法工作：{list} · {hk} 保存片段"]),
    ("pop.warn_nokey", ["Not working: {list}", "Nie działa: {list}", "Funktioniert nicht: {list}", "No funciona: {list}", "Ne marche pas : {list}", "Не працює: {list}", "Çalışmıyor: {list}", "動作していません: {list}", "无法工作：{list}"]),
    ("pop.marker", ["Marker added", "Znacznik dodany", "Marker hinzugefügt", "Marcador añadido", "Repère ajouté", "Позначку додано", "İşaret eklendi", "マーカーを追加しました", "已添加标记"]),
    ("pop.marker_sub", ["You'll see it as ◆ on the editor timeline", "Zobaczysz go jako ◆ na osi czasu w edytorze", "Im Editor als ◆ auf der Zeitleiste sichtbar", "Lo verás como ◆ en la línea de tiempo", "Visible comme ◆ sur la timeline de l'éditeur", "Побачите його як ◆ на шкалі часу в редакторі", "Düzenleyicide zaman çizelgesinde ◆ olarak görünür", "エディターのタイムラインに ◆ で表示されます", "在编辑器时间轴上显示为 ◆"]),
    ("menu.save", ["Save clip now", "Zapisz klip teraz", "Clip jetzt speichern", "Guardar clip ahora", "Enregistrer le clip", "Зберегти кліп зараз", "Klibi şimdi kaydet", "今すぐクリップを保存", "立即保存片段"]),
    ("menu.record", ["Record everything", "Nagrywaj całość", "Alles aufnehmen", "Grabar todo", "Tout enregistrer", "Записувати все", "Her şeyi kaydet", "すべて録画", "录制全部"]),
    ("menu.record_stop", ["Stop recording ({t})", "Zatrzymaj nagrywanie ({t})", "Aufnahme beenden ({t})", "Detener grabación ({t})", "Arrêter l'enregistrement ({t})", "Зупинити запис ({t})", "Kaydı durdur ({t})", "録画を停止 ({t})", "停止录制 ({t})"]),
    ("menu.open", ["Open editor", "Otwórz edytor", "Editor öffnen", "Abrir editor", "Ouvrir l'éditeur", "Відкрити редактор", "Düzenleyiciyi aç", "エディターを開く", "打开编辑器"]),
    ("menu.quit", ["Quit Buffer", "Zamknij Buffer", "Buffer beenden", "Cerrar Buffer", "Quitter Buffer", "Закрити Buffer", "Buffer'dan çık", "Buffer を終了", "退出 Buffer"]),
    ("lr.started", ["Recording started", "Nagrywanie rozpoczęte", "Aufnahme gestartet", "Grabación iniciada", "Enregistrement démarré", "Запис розпочато", "Kayıt başladı", "録画を開始しました", "已开始录制"]),
    ("lr.started_sub", ["{hk} stops", "{hk} kończy", "{hk} beendet", "{hk} detiene", "{hk} arrête", "{hk} зупиняє", "{hk} durdurur", "{hk} で停止", "{hk} 停止"]),
    ("lr.start_failed", ["Couldn't start recording", "Nie udało się rozpocząć nagrywania", "Aufnahme konnte nicht gestartet werden", "No se pudo iniciar la grabación", "Impossible de démarrer l'enregistrement", "Не вдалося розпочати запис", "Kayıt başlatılamadı", "録画を開始できませんでした", "无法开始录制"]),
    ("lr.saved", ["Recording saved", "Zapisano nagranie", "Aufnahme gespeichert", "Grabación guardada", "Enregistrement sauvegardé", "Запис збережено", "Kayıt kaydedildi", "録画を保存しました", "录制已保存"]),
    ("lr.stopped", ["Stopped: {r}", "Zatrzymano: {r}", "Gestoppt: {r}", "Detenida: {r}", "Arrêté : {r}", "Зупинено: {r}", "Durduruldu: {r}", "停止: {r}", "已停止：{r}"]),
    ("lr.save_failed", ["Couldn't save the recording", "Nie udało się zapisać nagrania", "Aufnahme konnte nicht gespeichert werden", "No se pudo guardar la grabación", "Échec de la sauvegarde de l'enregistrement", "Не вдалося зберегти запис", "Kayıt kaydedilemedi", "録画を保存できませんでした", "无法保存录制"]),
    ("err.busy", ["recording is already running", "nagrywanie już trwa", "Aufnahme läuft bereits", "ya hay una grabación en curso", "un enregistrement est déjà en cours", "запис уже триває", "kayıt zaten sürüyor", "すでに録画中です", "录制已在进行"]),
    ("err.space", ["not enough disk space", "za mało miejsca na dysku", "zu wenig Speicherplatz", "poco espacio en disco", "espace disque insuffisant", "замало місця на диску", "yetersiz disk alanı", "ディスク容量が不足しています", "磁盘空间不足"]),
    ("err.disk_full", ["the disk is almost full", "dysk jest prawie pełny", "Datenträger fast voll", "el disco está casi lleno", "le disque est presque plein", "диск майже заповнений", "disk neredeyse dolu", "ディスクがほぼ満杯です", "磁盘几乎已满"]),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_match_english_in_every_language() {
        let ph = |s: &str| {
            let mut v: Vec<String> = s.split('{').skip(1).filter_map(|p| p.split('}').next().map(String::from)).collect();
            v.sort();
            v
        };
        for (key, row) in TABLE {
            for (i, s) in row.iter().enumerate() {
                assert!(!s.is_empty(), "{key} empty for {}", CODES[i]);
                assert_eq!(ph(row[0]), ph(s), "{key} placeholders differ for {}", CODES[i]);
            }
        }
    }

    #[test]
    fn unknown_language_falls_back_to_english() {
        set("xx");
        assert_eq!(t("menu.quit"), "Quit Buffer");
        set("pl");
        assert_eq!(f("pop.postroll", &[("n", &5)]), "Zapisuję klip za 5 s");
        set("en");
    }
}
