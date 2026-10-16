"use strict";
/* RGB page, the parts around the lights: the profiles row, the automation bar under the panel (lights out on lock / idle /
   schedule, profiles per game), the conflict chip and the "Missing something?" link. State comes from the recorder (`rgb_status`). */

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

    /** The profiles row: one chip per profile (click = load). The active one shows a dot while it differs from what was
     *  saved, a "Save changes" button then appears next to it, and its × (shown on hover) deletes it. "+ New profile" turns
     *  into a name field. `reload` re-reads the scene. */
    profileBar(reload) {
      const names = stat.profiles || [], active = stat.profile, dirty = !!stat.profile_dirty, sizes = stat.profile_sizes || {};
      const bar = h("div", { class: "rprof" }, h("span", { class: "cap", text: App.t("rgb.profiles") }));
      const act = (fn) => async () => { try { await fn(); await A.refresh(); await reload(); } catch (e) { toast(e); } };
      for (const n of names) {
        const size = sizes[n] || 0, on = n === active;
        const chip = h("button", { class: "chip rp" + (on ? " on" : "") + (size ? "" : " empty"),
          title: size ? (on && dirty ? App.t("rgb.profileDirty") + " · " : "") + App.t("rgb.profileSize", { n: size }) : App.t("rgb.profileEmpty"),
          onClick: act(() => inv("rgb_profile", { action: "load", name: n })) }, h("span", { text: n }));
        if (on && dirty) chip.append(h("i", { class: "rdotm", "aria-hidden": "true" }));
        if (on) chip.append(h("span", { class: "rx", role: "button", "aria-label": App.t("rgb.profileDel"), title: App.t("rgb.profileDel"), text: "×",
          onClick: (e) => { e.stopPropagation(); act(() => inv("rgb_profile", { action: "delete", name: n }))(); } }));
        bar.append(chip);
      }
      if (active && dirty) bar.append(h("button", { class: "chip rp hot", text: App.t("rgb.profileSaveChanges"), onClick: act(() => inv("rgb_profile", { action: "save", name: active })) }));
      const add = h("button", { class: "chip rp add", text: "+ " + App.t("rgb.profileAdd"), title: App.t("rgb.profileNew") });
      add.onclick = () => {
        const inp = h("input", { class: "field rpname", placeholder: App.t("rgb.profileName"), maxlength: 40, spellcheck: false });
        const done = async () => {
          const name = inp.value.trim();
          try {
            await inv("rgb_profile", { action: "save", name });
            const n = ((await A.refresh()).profile_sizes || {})[name] || 0;
            // a profile that holds no device would change nothing when loaded: say so right away
            App.toast(n ? App.t("rgb.profileSaved", { name, n }) : App.t("rgb.profileEmpty"), n ? "ok" : "err");
            await reload();
          } catch (e) { toast(e); }
        };
        inp.onkeydown = (e) => { if (e.key === "Enter" && inp.value.trim()) done(); if (e.key === "Escape") reload(); };
        inp.onblur = () => { if (!inp.value.trim()) reload(); };
        add.replaceWith(inp);
        inp.focus();
      };
      bar.append(add);
      return bar;
    },

    /** The bar under the panel: when the lights go out by themselves, and a pop-up for the profile a game switches to. */
    bar(reload, devs) {
      const p = stat.power || { lock: true, idle_min: 0, schedule: false, from: 1380, to: 420 };
      const save = async (patch) => { Object.assign(p, patch); try { await inv("rgb_power", { power: p }); await A.refresh(); } catch (e) { toast(e); } };
      const tog = (on, fn) => h("span", { class: "toggle" + (on ? " on" : ""), role: "switch", onClick: (e) => { const t = e.currentTarget; t.classList.toggle("on"); fn(t.classList.contains("on")); } });
      const idle = h("select", { class: "field" }, [0, 2, 5, 10, 20, 30, 60].map((m) => h("option", { value: m, text: m ? App.t("rgb.minutes", { n: m }) : App.t("rgb.never"), selected: m === p.idle_min })));
      idle.onchange = () => save({ idle_min: +idle.value });
      const from = h("input", { class: "field", type: "time", value: hm(p.from) }), to = h("input", { class: "field", type: "time", value: hm(p.to) });
      from.onchange = () => { const m = minutes(from.value); if (m != null) save({ from: m }); };
      to.onchange = () => { const m = minutes(to.value); if (m != null) save({ to: m }); };

      // games: one row per game seen by the EQ, each with a choice of profile
      const pop = h("div", { class: "agpop", hidden: true });
      const fillGames = async () => {
        const r = await inv("recorder_cmd", { cmd: "eq-get" }).catch(() => null);
        const st = (r && r.ok && r.state) || {};
        const seen = st.seen_games || {};
        const list = (st.recent_games && st.recent_games.length ? st.recent_games : Object.keys(seen).sort());
        const profs = stat.profiles || [];
        pop.replaceChildren(...(list.length && profs.length ? list.map((g) => {
          const sel = h("select", { class: "field" }, h("option", { value: "-", text: "—" }), profs.map((n) => h("option", { value: n, text: n, selected: (stat.game_profiles || {})[g] === n })));
          sel.onchange = async () => { try { await inv("rgb_game_profile", { game: g, profile: sel.value }); await A.refresh(); } catch (e) { toast(e); } };
          return h("div", { class: "arow" }, h("span", { text: (seen[g] || g).replace(/-/g, " ") }), sel);
        }) : [h("div", { class: "faint", text: App.t(profs.length ? "rgb.gamesNone" : "rgb.gamesNoProfile") })]));
      };
      const gbtn = h("button", { class: "chip rp", text: App.t("rgb.games") + " ▾", title: App.t("rgb.gamesTip"), onClick: async (e) => {
        e.stopPropagation();
        if (pop.hidden) await fillGames();
        pop.hidden = !pop.hidden;
      } });
      document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; });

      const grp = (label, ...ctl) => h("div", { class: "afg" }, h("span", { text: label }), ...ctl);
      return h("div", { class: "rfoot" },
        h("span", { class: "cap", text: App.t("rgb.autoLights"), title: App.t("rgb.autoTip") }),
        grp(App.t("rgb.autoLock"), tog(p.lock, (v) => save({ lock: v }))),
        grp(App.t("rgb.autoIdle"), idle),
        grp(App.t("rgb.autoSched"), from, h("span", { text: "–" }), to, tog(p.schedule, (v) => save({ schedule: v }))),
        h("span", { class: "afdiv" }),
        h("div", { class: "agwrap" }, gbtn, pop),
        h("span", { class: "sp" }),
        A.missingLink(devs));
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
