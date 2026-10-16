"use strict";
/* RGB page, the parts around the lights: profiles bar, the automation card (lights out on lock / idle / schedule,
   profiles per game), the conflict chip and the "Missing something?" button. State comes from the recorder (`rgb_status`). */

(function () {
  const { h, api } = App;
  const inv = (c, a) => api.invoke(c, a);
  const toast = (e) => App.toast(App.t("rgb.err", { err: e }), "err");
  let stat = {};

  const hm = (min) => String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
  const minutes = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null; };

  const A = (App.RGBAuto = {
    stat: () => stat,
    async refresh() {
      try { stat = (await inv("rgb_status")) || {}; } catch (_) { /* keep the last */ }
      return stat;
    },

    /** Other lighting programs that run and may overwrite our colours. */
    conflictChip() {
      const c = stat.conflicts || [];
      if (!c.length) return null;
      return h("span", { class: "chip warn", text: "⚠ " + c[0] + (c.length > 1 ? " +" + (c.length - 1) : ""), title: App.t("rgb.conflictTip", { apps: c.join(", ") }) });
    },

    /** "Lights are out" while a lock / idle / schedule rule holds them off. */
    awayChip() {
      return stat.away ? h("span", { class: "chip", text: App.t("rgb.away." + stat.away), title: App.t("rgb.awayTip") }) : null;
    },

    /** Profile chips: click loads, the active one can be saved over (when changed) or deleted. `reload` re-reads the scene. */
    profileBar(reload) {
      const names = stat.profiles || [], active = stat.profile, dirty = !!stat.profile_dirty;
      const bar = h("div", { class: "rprof" }, h("span", { class: "cap", text: App.t("rgb.profiles") }));
      const act = (fn) => async () => { try { await fn(); await A.refresh(); await reload(); } catch (e) { toast(e); } };
      for (const n of names) {
        bar.append(h("button", { class: "chip" + (n === active ? " on" : ""), text: n + (n === active && dirty ? " •" : ""),
          title: n === active && dirty ? App.t("rgb.profileDirty") : null,
          onClick: act(() => inv("rgb_profile", { action: "load", name: n })) }));
      }
      if (active && dirty) bar.append(h("button", { class: "chip", text: App.t("rgb.profileSave"), onClick: act(() => inv("rgb_profile", { action: "save", name: active })) }));
      if (active) bar.append(h("button", { class: "chip", text: "✕", title: App.t("rgb.profileDel"), onClick: act(() => inv("rgb_profile", { action: "delete", name: active })) }));
      const add = h("button", { class: "chip", text: "+", title: App.t("rgb.profileNew") });
      add.onclick = () => {
        const inp = h("input", { class: "field rpname", placeholder: App.t("rgb.profileName"), maxlength: 40, spellcheck: false });
        const done = act(() => inv("rgb_profile", { action: "save", name: inp.value.trim() }));
        inp.onkeydown = (e) => { if (e.key === "Enter" && inp.value.trim()) done(); if (e.key === "Escape") reload(); };
        inp.onblur = () => { if (!inp.value.trim()) reload(); };
        add.replaceWith(inp);
        inp.focus();
      };
      bar.append(add);
      return bar;
    },

    /** Automation: when the lights go out by themselves, and which profile a game switches to. */
    card(reload) {
      const p = stat.power || { lock: true, idle_min: 0, schedule: false, from: 1380, to: 420 };
      const save = async (patch) => { Object.assign(p, patch); try { await inv("rgb_power", { power: p }); await A.refresh(); } catch (e) { toast(e); } };
      const row = (label, ctl, tip) => h("div", { class: "arow", title: tip || null }, h("span", { text: label }), ctl);
      const tog = (on, fn) => h("span", { class: "toggle" + (on ? " on" : ""), role: "switch", onClick: (e) => { const t = e.currentTarget; t.classList.toggle("on"); fn(t.classList.contains("on")); } });
      const idle = h("select", { class: "field" }, [0, 2, 5, 10, 20, 30, 60].map((m) => h("option", { value: m, text: m ? App.t("rgb.minutes", { n: m }) : App.t("rgb.never"), selected: m === p.idle_min })));
      idle.onchange = () => save({ idle_min: +idle.value });
      const from = h("input", { class: "field", type: "time", value: hm(p.from) }), to = h("input", { class: "field", type: "time", value: hm(p.to) });
      from.onchange = () => { const m = minutes(from.value); if (m != null) save({ from: m }); };
      to.onchange = () => { const m = minutes(to.value); if (m != null) save({ to: m }); };
      const games = h("div", { class: "agames" });
      const fillGames = async () => {
        const r = await inv("recorder_cmd", { cmd: "eq-get" }).catch(() => null);
        const st = (r && r.ok && r.state) || {};
        const seen = st.seen_games || {};
        const list = (st.recent_games && st.recent_games.length ? st.recent_games : Object.keys(seen).sort());
        const profs = stat.profiles || [];
        games.replaceChildren(h("div", { class: "cap", text: App.t("rgb.games") }),
          ...(list.length && profs.length ? list.map((g) => {
            const sel = h("select", { class: "field" }, h("option", { value: "-", text: "—" }), profs.map((n) => h("option", { value: n, text: n, selected: (stat.game_profiles || {})[g] === n })));
            sel.onchange = async () => { try { await inv("rgb_game_profile", { game: g, profile: sel.value }); await A.refresh(); } catch (e) { toast(e); } };
            return h("div", { class: "arow" }, h("span", { text: (seen[g] || g).replace(/-/g, " ") }), sel);
          }) : [h("div", { class: "faint", text: App.t(profs.length ? "rgb.gamesNone" : "rgb.gamesNoProfile") })]));
      };
      const box = h("details", { class: "card2 pad rauto" },
        h("summary", { class: "cap", text: App.t("rgb.auto") }),
        row(App.t("rgb.autoLock"), tog(p.lock, (v) => save({ lock: v }))),
        row(App.t("rgb.autoIdle"), idle),
        row(App.t("rgb.autoSched"), h("span", { class: "asched" }, from, h("span", { text: "–" }), to, tog(p.schedule, (v) => save({ schedule: v })))),
        games);
      box.addEventListener("toggle", () => { if (box.open) fillGames(); });
      return box;
    },

    /** "Missing something?": opens a pre-filled GitHub issue (nothing is sent until the user submits it there). */
    missingLink(devs) {
      return h("button", { class: "linkbtn rmiss", text: App.t("rgb.missing"), title: App.t("rgb.missingTip"), onClick: async () => {
        const ver = await App.Update.version().catch(() => "");
        const body = `${App.t("rgb.missingBody")}\n\n\n---\nBuffer ${ver || ""}\nRGB: ${(devs || []).map((d) => d.name).join(", ")}`;
        const url = "https://github.com/Wheatlay/Buffer/issues/new?labels=rgb&title=" + encodeURIComponent("RGB: ") + "&body=" + encodeURIComponent(body);
        try { await inv("open_issue_page", { url }); } catch (e) { toast(e); }
      } });
    },
  });
})();
