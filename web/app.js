import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const cfg = window.GIFT_CONFIG || {};
const configured = cfg.supabaseUrl && cfg.supabaseAnonKey && !/YOUR-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey);
const sb = configured ? createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

let me = null;         // signed-in auth user
let D = null;          // everything this user can read
let sel = null;        // selected person id
let selOcc = null;     // selected occasion id (occasion list view)
let channel = null;
let reloadTimer = null, reloadPending = false;
const ui = { editing: false, sug: {}, prompt: {}, busy: null, sugErr: {}, filter: {}, modal: null, authMode: "signin" };
const STATUS = { idea: "Idea", bought: "Bought", given: "Given ✓" };

// ---------- small helpers ----------
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
}
async function run(query) {
  const { data, error } = await query;
  if (error) { toast(error.message); throw error; }
  return data;
}
function confirmClick(b, text) {
  if (b.dataset.confirm === "1") return true;
  b.dataset.confirm = "1"; b.textContent = text;
  return false;
}
const currency = () => D.profile.currency || "NOK";
const nameOf = (uid) => (uid === me.id ? "you" : D.profiles[uid]?.display_name || "Someone");
const groupName = (gid) => D.groups.find((g) => g.id === gid)?.name || "a group";
const groupMembers = (gid) => D.members.filter((m) => m.group_id === gid).map((m) => m.user_id);
const giftsOf = (pid) => D.gifts.filter((g) => g.person_id === pid);
const wishesOf = (pid) => D.wishes.filter((w) => w.person_id === pid);
const occKey = (g) => (g.for_birthday ? "birthday" : g.occasion_id || "");
const occFields = (key) => ({ occasion_id: key && key !== "birthday" ? key : null, for_birthday: key === "birthday" });
const hiddenFromMe = (p) => p.member_id === me.id;
const person = () => D.people.find((x) => x.id === sel);
const sumPrice = (gs) => gs.reduce((a, g) => a + (Number(g.price) || 0), 0);
const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");
const isUrl = (s) => /^https?:\/\/\S+$/i.test((s || "").trim());
function replaceLocal(list, row) { const i = list.findIndex((x) => x.id === row.id); if (i >= 0) list[i] = row; else list.push(row); }

// ---------- dates & money ----------
function todayDate() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function parseDate(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); }
function nextBirthday(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split("-").map(Number);
  const t = todayDate();
  let n = new Date(t.getFullYear(), m - 1, d);
  if (n < t) n = new Date(t.getFullYear() + 1, m - 1, d);
  return n;
}
const daysUntil = (date) => Math.round((date - todayDate()) / 86400000);
const fmtDate = (date) => date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
const inDays = (n) => (n === 0 ? "today" : n === 1 ? "tomorrow" : n < 0 ? `${-n} days ago` : `in ${n} days`);
function money(n) {
  const v = Number(n) || 0;
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency(), maximumFractionDigits: 0 }).format(v); }
  catch { return `${Math.round(v).toLocaleString()} ${currency()}`; }
}
function totals(p) {
  let spent = 0, planned = 0;
  for (const g of giftsOf(p.id)) { const v = Number(g.price) || 0; if (g.status === "idea") planned += v; else spent += v; }
  return { spent, planned, budget: Number(p.budget) || 0 };
}
function meter(p, big) {
  const { spent, planned, budget } = totals(p);
  const cap = Math.max(budget, spent + planned, 1);
  const over = budget > 0 && spent > budget;
  return `<div class="meter${big ? " big" : ""}${over ? " over" : ""}" role="img" aria-label="Spent ${esc(money(spent))} of ${esc(money(budget))}">
    <i class="spent" style="width:${(spent / cap) * 100}%"></i><i class="planned" style="width:${(planned / cap) * 100}%"></i></div>`;
}
function upcoming() {
  const ev = [];
  for (const o of D.occasions) { const d = parseDate(o.date); if (daysUntil(d) >= 0) ev.push({ name: o.name, date: d }); }
  for (const p of D.people) { const d = nextBirthday(p.birthday); if (d) ev.push({ name: `${p.name}'s birthday`, date: d }); }
  return ev.sort((a, b) => a.date - b.date);
}
function occasionLabel(id) {
  if (id === "birthday") return "Birthday";
  return D.occasions.find((o) => o.id === id)?.name || "";
}
function occOpts(cur) {
  return `<option value="">No occasion</option><option value="birthday"${cur === "birthday" ? " selected" : ""}>Birthday</option>` +
    D.occasions.map((o) => `<option value="${o.id}"${cur === o.id ? " selected" : ""}>${esc(o.name)}</option>`).join("");
}
function groupOpts(cur) {
  return `<option value="">Only me</option>` + D.groups.map((g) => `<option value="${g.id}"${cur === g.id ? " selected" : ""}>${esc(g.name)}</option>`).join("");
}
function memberOpts(gid, ownerId, cur) {
  const ids = gid ? groupMembers(gid).filter((u) => u !== ownerId) : [];
  return `<option value="">No one</option>` + ids.map((u) => `<option value="${u}"${cur === u ? " selected" : ""}>${esc(D.profiles[u]?.display_name || "Member")}</option>`).join("");
}

// ---------- data ----------
async function loadAll() {
  const [profiles, groups, members, people, occasions, wishes, gifts] = await Promise.all([
    run(sb.from("profiles").select("*")),
    run(sb.from("groups").select("*").order("created_at")),
    run(sb.from("group_members").select("*")),
    run(sb.from("people").select("*").order("created_at")),
    run(sb.from("occasions").select("*").order("date")),
    run(sb.from("wishlist_items").select("*").order("created_at")),
    run(sb.from("gifts").select("*").order("created_at")),
  ]);
  D = { profiles: Object.fromEntries(profiles.map((p) => [p.id, p])), groups, members, people, occasions, wishes, gifts };
  D.profile = D.profiles[me.id] || { id: me.id, display_name: "", currency: "NOK", country: "Norway" };
  if (sel && !people.some((p) => p.id === sel)) sel = null;
  sel ||= people[0]?.id || null;
  if (selOcc && !occasions.some((o) => o.id === selOcc)) selOcc = null;
  $("#saveState").textContent = "Saved to your account";
  render();
}

// Reload when anything changes, but never while someone is typing.
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { reloadPending = true; return; }
    loadAll().catch(() => {});
  }, 400);
}
document.addEventListener("focusout", () => {
  if (!reloadPending) return;
  setTimeout(() => {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    reloadPending = false; loadAll().catch(() => {});
  }, 50);
});

function subscribe() {
  channel = sb.channel("gift-tracker")
    .on("postgres_changes", { event: "*", schema: "public" }, scheduleReload)
    .subscribe();
}

// ---------- auth ----------
function renderAuth(msg, isError) {
  const signup = ui.authMode === "signup";
  $("#authTitle").textContent = signup ? "Create an account" : "Sign in";
  $("#authNameField").hidden = !signup;
  $("#authSubmit").textContent = signup ? "Create account" : "Sign in";
  $("#authPassword").autocomplete = signup ? "new-password" : "current-password";
  $("#authSwitchText").textContent = signup ? "Already have an account?" : "No account yet?";
  $("#authSwitch").textContent = signup ? "Sign in" : "Create one";
  const m = $("#authMsg");
  m.hidden = !msg; m.textContent = msg || ""; m.classList.toggle("err", !!isError);
}

function showView(signedIn) {
  $("#authView").hidden = signedIn;
  $("#appView").hidden = !signedIn;
  $("#userBox").hidden = !signedIn;
  if (!signedIn) { $("#summary").innerHTML = ""; $("#saveState").textContent = "Sign in to see your list"; renderAuth(); }
}

let sessionKnown = false;
function onSession(session) {
  const u = session?.user || null;
  if (sessionKnown && (u?.id || null) === (me?.id || null)) return;
  sessionKnown = true;
  me = u;
  if (channel) { sb.removeChannel(channel); channel = null; }
  if (ui.modal) closeModal();
  D = null; sel = null; selOcc = null; ui.sug = {}; ui.filter = {}; ui.editing = false;
  showView(!!me);
  if (me) {
    $("#saveState").textContent = "Loading your list…";
    $("#main").innerHTML = `<section class="panel welcome"><p class="muted">Opening your gift list…</p></section>`;
    loadAll().catch(() => {});
    subscribe();
  }
}

// ---------- rendering ----------
function render() {
  if (!D) return;
  $("#userName").textContent = D.profile.display_name || me.email;
  renderSummary(); renderPeople(); renderOccasions(); renderGroups(); renderSettings(); renderMain();
}

function renderSummary() {
  const next = upcoming()[0];
  let spent = 0, budget = 0;
  for (const p of D.people) { const t = totals(p); spent += t.spent; budget += t.budget; }
  $("#summary").innerHTML =
    (next ? `<div><span class="label">Next up</span><br><b>${esc(next.name)}</b> · ${fmtDate(next.date)} · ${inDays(daysUntil(next.date))}</div>` : "") +
    (D.people.length ? `<div><span class="label">Spent so far</span><br><b class="num">${esc(money(spent))}</b> <span class="muted">of ${esc(money(budget))} across ${D.people.length} ${D.people.length === 1 ? "person" : "people"}</span></div>` : "");
}

function renderPeople() {
  const list = $("#peopleList");
  if (!D.people.length) { list.innerHTML = `<li class="empty">Nobody here yet.</li>`; return; }
  const sorted = [...D.people].sort((a, b) => (nextBirthday(a.birthday) || 9e15) - (nextBirthday(b.birthday) || 9e15));
  list.innerHTML = sorted.map((p) => {
    const nb = nextBirthday(p.birthday);
    const meta = [p.relation, nb ? `birthday ${fmtDate(nb)}` : ""].filter(Boolean).join(" · ");
    const n = giftsOf(p.id).length;
    return `<li><button class="person-btn" data-act="select" data-id="${p.id}" aria-current="${p.id === sel && !selOcc}">
      <span class="pname">${esc(p.name)}${p.group_id ? `<span class="badge">${esc(groupName(p.group_id))}</span>` : ""}</span>
      <span class="num muted" style="font-size:12.5px">${hiddenFromMe(p) ? "" : `${n} gift${n === 1 ? "" : "s"}`}</span>
      ${meta ? `<span class="pmeta">${esc(meta)}</span>` : ""}
      ${p.budget && !hiddenFromMe(p) ? meter(p) : ""}
    </button></li>`;
  }).join("");
}

function renderOccasions() {
  $("#occList").innerHTML = D.occasions.length ? D.occasions.map((o) => {
    const d = parseDate(o.date), n = daysUntil(d);
    return `<li class="${n < 0 ? "past" : ""}"><button class="oname" data-act="open-occ" data-id="${o.id}" aria-current="${o.id === selOcc}">${esc(o.name)}${o.group_id ? `<span class="badge">${esc(groupName(o.group_id))}</span>` : ""}</button><span class="when">${fmtDate(d)} · ${inDays(n)}</span>
      ${o.owner_id === me.id ? `<button class="ghost" data-act="del-occ" data-id="${o.id}" aria-label="Remove ${esc(o.name)}">✕</button>` : "<span></span>"}</li>`;
  }).join("") : `<li class="empty">No occasions yet. Add Christmas or a birthday party below.</li>`;
  const scope = $("#occScope");
  if (document.activeElement !== scope) scope.innerHTML = groupOpts(scope.value);
  scope.hidden = !D.groups.length;
}

function renderGroups() {
  $("#groupList").innerHTML = D.groups.length ? D.groups.map((g) => `
    <li class="grp">
      <div class="grp-top"><b>${esc(g.name)}</b>
        ${g.created_by === me.id
          ? `<button class="ghost danger" data-act="del-group" data-id="${g.id}">Delete</button>`
          : `<button class="ghost" data-act="leave-group" data-id="${g.id}">Leave</button>`}</div>
      <div class="sub">${esc(groupMembers(g.id).map(nameOf).join(", "))}</div>
      <div class="row"><span class="label">Invite code</span><code>${esc(g.invite_code)}</code>
        <button class="ghost" data-act="copy-code" data-code="${esc(g.invite_code)}">Copy</button></div>
    </li>`).join("")
    : `<li class="empty">Create a group to share people and occasion lists with family or friends, or join one with an invite code.</li>`;
}

function renderSettings() {
  for (const el of document.querySelectorAll("[data-setting]")) {
    if (document.activeElement !== el) el.value = D.profile[el.dataset.setting] || "";
  }
}

// Title (linked to the product page when there is one), optional thumbnail and sub-line.
function itemHead(title, sub, item) {
  const url = safeUrl(item.url), img = safeUrl(item.image_url);
  return `<div class="item-head">
    ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
    <div><div class="title">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>` : esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
  </div>`;
}

function giftRow(p, g) {
  const byOther = g.status !== "idea" && g.bought_by && g.bought_by !== me.id;
  const sub = [g.store, byOther ? `bought by ${nameOf(g.bought_by)}` : ""].filter(Boolean).join(" · ");
  return `<li>${itemHead(g.title, sub, g)}
    <div class="ctrls">
      <select id="occ-${g.id}" data-gift-occ="${g.id}" aria-label="Occasion for ${esc(g.title)}">${occOpts(occKey(g))}</select>
      ${Number(g.price) ? `<span class="tag">${esc(money(g.price))}</span>` : ""}
      <button class="status ${g.status}" data-act="cycle" data-id="${g.id}">${STATUS[g.status]}</button>
      <button class="ghost" data-act="edit-gift" data-id="${g.id}" aria-label="Edit ${esc(g.title)}">Edit</button>
      <button class="ghost" data-act="del-gift" data-id="${g.id}" aria-label="Remove ${esc(g.title)}">✕</button>
    </div></li>`;
}

function renderOccasionView(o) {
  const d = parseDate(o.date), n = daysUntil(d);
  const visible = D.people.filter((p) => !hiddenFromMe(p) && (!o.group_id || p.group_id === o.group_id || p.owner_id === me.id));
  const rows = visible.map((p) => ({ p, gifts: giftsOf(p.id).filter((g) => g.occasion_id === o.id) }));
  const all = rows.flatMap((r) => r.gifts);
  const by = (s) => all.filter((g) => g.status === s);
  const done = rows.filter((r) => r.gifts.some((g) => g.status !== "idea")).length;
  const withGifts = rows.filter((r) => r.gifts.length), without = rows.filter((r) => !r.gifts.length);
  const addBtn = (p, label) => `<button data-act="open-add" data-pid="${p.id}" data-occ="${o.id}" aria-label="Add a gift for ${esc(p.name)}">${label}</button>`;
  return `
    <section class="panel">
      <div class="phead">
        <div style="display:flex;flex-direction:column;gap:6px">
          <span class="label">Occasion list${o.group_id ? ` · shared with ${esc(groupName(o.group_id))}` : ""}</span>
          <h2>${esc(o.name)}</h2>
          <div class="facts"><span>${d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span><span>${inDays(n)}</span></div>
        </div>
        <div class="stats">
          <div><span class="label">Ideas</span><br><b class="num">${by("idea").length}</b> <span class="muted num">${esc(money(sumPrice(by("idea"))))}</span></div>
          <div><span class="label">Bought</span><br><b class="num">${by("bought").length}</b> <span class="muted num">${esc(money(sumPrice(by("bought"))))}</span></div>
          <div><span class="label">Given</span><br><b class="num">${by("given").length}</b> <span class="muted num">${esc(money(sumPrice(by("given"))))}</span></div>
          <div><span class="label">People covered</span><br><b class="num">${done} of ${visible.length}</b></div>
        </div>
      </div>
    </section>
    <section class="panel">
      <div class="sec-head"><h3>Gifts for ${esc(o.name)}</h3><span class="note">Grouped by person</span></div>
      ${withGifts.length ? `<div>${withGifts.map(({ p, gifts }) => `
        <div class="group">
          <div class="group-head"><button data-act="select" data-id="${p.id}">${esc(p.name)}</button>
            <span class="num muted" style="font-size:13px">${esc(money(sumPrice(gifts)))}</span></div>
          <ul class="items">${gifts.map((g) => giftRow(p, g)).join("")}</ul>
          <div class="row">${addBtn(p, "Add gift")}</div>
        </div>`).join("")}</div>`
        : `<p class="empty" style="margin:0">No gifts on this list yet. Add one for someone below, or pick ${esc(o.name)} as the occasion on any gift.</p>`}
    </section>
    ${without.length ? `
    <section class="panel">
      <div class="sec-head"><h3>Nothing planned yet</h3><span class="note">${without.length} ${without.length === 1 ? "person" : "people"} without a gift for ${esc(o.name)}</span></div>
      <div class="todo">${without.map(({ p }) => `
        <button class="ghost" data-act="select" data-id="${p.id}" style="text-align:left;padding-left:0;color:var(--ink);font-weight:600">${esc(p.name)}</button>
        <div class="row">${addBtn(p, "Add gift")}</div>`).join("")}</div>
    </section>` : ""}`;
}

function renderMain() {
  const main = $("#main");
  if (selOcc) {
    const o = D.occasions.find((x) => x.id === selOcc);
    if (o) { main.innerHTML = renderOccasionView(o); return; }
    selOcc = null;
  }
  const p = person();
  if (!p) {
    main.innerHTML = `<section class="panel welcome">
      <h2>Who are you buying for?</h2>
      <p>Add the people on your list with their birthday, where they live and a budget. Keep their wishlist and your gift ideas in one place, mark gifts as bought or given, and get suggestions they can find in shops in their own country.</p>
      <p class="muted">Buying with family? Create a group, share the invite code, and share people with the group so nobody buys the same gift twice.</p>
      <div class="row"><button class="primary" data-act="add-person">Add your first person</button></div>
    </section>`;
    return;
  }
  const mine = p.owner_id === me.id;
  const hidden = hiddenFromMe(p);
  const nb = nextBirthday(p.birthday);
  const t = totals(p);
  const left = t.budget - t.spent - t.planned;
  const gifts = giftsOf(p.id), wishes = wishesOf(p.id);
  const f = ui.filter[p.id] || "all";
  const focusOcc = f !== "all" && f !== "none" ? f : "";
  const shown = f === "all" ? gifts : gifts.filter((g) => (occKey(g) || "none") === f);
  const chipIds = ["birthday", ...D.occasions.filter((o) => daysUntil(parseDate(o.date)) >= 0 || gifts.some((g) => g.occasion_id === o.id)).map((o) => o.id)];
  if (gifts.some((g) => !occKey(g))) chipIds.push("none");
  const chip = (v, label) => `<button class="chip" data-act="filter" data-v="${v}" aria-pressed="${f === v}">${esc(label)}</button>`;
  const chips = `<div class="chips" role="group" aria-label="Show gifts for">${chip("all", "All")}${chipIds.map((v) => chip(v, v === "none" ? "No occasion" : occasionLabel(v))).join("")}</div>`;

  const head = ui.editing ? `
    <form class="panel" data-form="person" id="personForm">
      <h2>Edit details</h2>
      <div class="edit-grid">
        <div class="field"><label for="pfName">Name</label><input id="pfName" name="name" value="${esc(p.name)}" required></div>
        <div class="field"><label for="pfRel">Relation</label><input id="pfRel" name="relation" value="${esc(p.relation)}" placeholder="Sister, colleague…"></div>
        <div class="field"><label for="pfCountry">Lives in</label><input id="pfCountry" name="country" value="${esc(p.country)}" placeholder="${esc(D.profile.country)}"></div>
        <div class="field"><label for="pfBday">Birthday</label><input id="pfBday" name="birthday" type="date" value="${esc(p.birthday || "")}"></div>
        <div class="field"><label for="pfBudget">Budget (${esc(currency())})</label><input id="pfBudget" name="budget" type="number" min="0" step="50" value="${esc(Number(p.budget) || "")}"></div>
        <div class="field"><label for="pfGroup">Shared with</label><select id="pfGroup" name="group_id" ${mine ? "" : "disabled"}>${groupOpts(p.group_id)}</select></div>
        <div class="field"><label for="pfMember">Is this a group member? Hide gifts from</label><select id="pfMember" name="member_id" ${mine && p.group_id ? "" : "disabled"}>${memberOpts(p.group_id, p.owner_id, p.member_id)}</select></div>
      </div>
      ${mine ? "" : `<p class="note" style="margin:0">${esc(nameOf(p.owner_id))} added ${esc(p.name)}, so only they can change who it's shared with.</p>`}
      <div class="row" style="justify-content:space-between">
        <div class="row"><button class="primary" type="submit">Save</button><button type="button" data-act="cancel-edit">Cancel</button></div>
        ${mine ? `<button type="button" class="danger" data-act="del-person">Remove ${esc(p.name)}</button>` : ""}
      </div>
    </form>` : `
    <section class="panel">
      <div class="phead">
        <div style="display:flex;flex-direction:column;gap:6px">
          <h2>${esc(p.name)}</h2>
          <div class="facts">
            ${p.relation ? `<span>${esc(p.relation)}</span>` : ""}
            <span>Lives in ${esc(p.country || D.profile.country)}</span>
            ${nb ? `<span>Birthday ${fmtDate(nb)}, ${inDays(daysUntil(nb))}</span>` : ""}
            ${p.group_id ? `<span>Shared with ${esc(groupName(p.group_id))}${mine ? "" : `, added by ${esc(nameOf(p.owner_id))}`}</span>` : ""}
          </div>
          <div><button class="ghost" data-act="edit" style="padding-left:0">Edit details</button></div>
        </div>
        ${hidden ? "" : `<div class="budget">
          <div class="nums"><span class="label">Budget</span><span class="num">${t.budget ? esc(money(t.budget)) : "Not set"}</span></div>
          ${meter(p, true)}
          <div class="nums"><div class="legend"><span>Bought ${esc(money(t.spent))}</span><span class="pl">Planned ${esc(money(t.planned))}</span></div>
          ${t.budget ? `<span class="num" style="color:${left < 0 ? "var(--warn)" : "var(--muted)"}">${left < 0 ? esc(money(-left)) + " over" : esc(money(left)) + " left"}</span>` : ""}</div>
        </div>`}
      </div>
      <div class="field">
        <label for="pLikes">What they like, sizes, things they already have</label>
        <textarea id="pLikes" data-field="likes" rows="3" placeholder="Loves trail running and good coffee. Size M. Already has an AeroPress.">${esc(p.likes)}</textarea>
      </div>
    </section>`;

  const wish = `
    <section class="panel">
      <div class="sec-head"><h3>${hidden ? "Your wishlist" : "Their wishlist"}</h3><span class="note">${hidden ? "Everyone in the group can see this" : `What ${esc(p.name)} has asked for`}</span></div>
      <ul class="items">${wishes.length ? wishes.map((w) => `
        <li>${itemHead(w.text, "", w)}
        <div class="ctrls">${Number(w.price) ? `<span class="tag">${esc(money(w.price))}</span>` : ""}
          ${hidden ? "" : `<button data-act="plan-wish" data-id="${w.id}">Add to gifts</button>`}
          <button class="ghost" data-act="edit-wish" data-id="${w.id}" aria-label="Edit ${esc(w.text)}">Edit</button>
          <button class="ghost" data-act="del-wish" data-id="${w.id}" aria-label="Remove ${esc(w.text)}">✕</button></div></li>`).join("")
        : `<li class="empty">No wishes noted yet. Add what ${hidden ? "you'd like" : "they've mentioned wanting"}.</li>`}</ul>
      <form class="row" data-form="wish" id="wishForm">
        <input id="wishText" name="text" placeholder="Wireless earbuds, a cookbook…" aria-label="Wish" required>
        <input id="wishPrice" name="price" type="number" min="0" class="short" placeholder="Price" aria-label="Approximate price">
        <button type="submit">Add wish</button>
      </form>
    </section>`;

  if (hidden) {
    main.innerHTML = head + (ui.editing ? "" : wish) + `<section class="panel"><h3>Gifts</h3><p class="hidden-note">${esc(nameOf(p.owner_id))} linked this person to your account, so the gifts planned for you are hidden from you.</p></section>`;
    return;
  }

  const giftsSec = `
    <section class="panel">
      <div class="sec-head"><h3>Gifts${f !== "all" ? ` · ${esc(f === "none" ? "No occasion" : occasionLabel(f))}` : ""}</h3>
        <div class="row"><span class="note">${shown.length ? `${shown.length} · ${esc(money(sumPrice(shown)))}` : ""}</span>
        <button class="primary" data-act="open-add" data-pid="${p.id}" data-occ="${focusOcc}" id="addGiftBtn">Add gift</button></div></div>
      ${chips}
      <ul class="items">${shown.length ? shown.map((g) => giftRow(p, g)).join("")
        : `<li class="empty">${f === "all" ? "No gifts yet. Click Add gift, move a wish over, or ask for suggestions." : "No gifts for this occasion yet."}</li>`}</ul>
      <p class="note" style="margin:0">Click the status to move it along: idea, bought, given.</p>
    </section>`;

  const sugs = ui.sug[p.id] || [];
  const country = p.country || D.profile.country;
  const suggest = `
    <section class="panel suggest">
      <div class="sec-head"><h3>Suggest gifts${focusOcc ? ` for ${esc(occasionLabel(focusOcc))}` : ""}</h3><span class="note">Based on their wishlist, notes and budget, from shops in ${esc(country)}</span></div>
      <form class="row" data-form="suggest" id="suggestForm">
        <input id="sugPrompt" name="prompt" value="${esc(ui.prompt[p.id] || "")}" placeholder="Optional: under 500 kr, something for the cabin, an experience…" aria-label="What should the suggestions focus on">
        <button class="primary" type="submit" ${ui.busy ? "disabled" : ""}>${sugs.length ? "Suggest more" : "Suggest gifts"}</button>
      </form>
      ${ui.busy === p.id ? `<div class="thinking">Looking through what ${esc(p.name)} likes</div>` : ""}
      ${ui.sugErr[p.id] ? `<div class="err">${esc(ui.sugErr[p.id])}</div>` : ""}
      ${sugs.length ? `<div class="sug-grid">${sugs.map((s, i) => `
        <div class="sug">
          <div class="title" style="font-weight:600">${esc(s.title)}</div>
          <div class="why">${esc(s.why)}</div>
          <div class="stores"><span class="label">Find it at</span><br>${esc(s.stores.join(", "))}</div>
          <div class="foot"><span class="tag">≈ ${esc(money(s.price))}${s.localPrice && !s.localPrice.includes(currency()) ? ` · ${esc(s.localPrice)}` : ""}</span>
          ${s.added ? `<span class="note">Added</span>` : `<button data-act="add-sug" data-i="${i}">Add to gifts</button>`}</div>
        </div>`).join("")}</div>
        <p class="note" style="margin:0">Prices and stock are estimates. Check the store before buying.</p>` : ""}
    </section>`;

  main.innerHTML = head + (ui.editing ? "" : wish + giftsSec + suggest);
}

// ---------- gift pane ----------
// Step 1 ("input"): one "Gift idea" field. A link is read for its details; any
// other text becomes the name. Step 2 ("details"): name, store, price, link and
// occasion, pre-filled from the link where possible. Editing a gift opens step 2
// directly. Wishlist links reuse the pane with target "wish".
function saveLabel(M) {
  if (M.editId) return "Save changes";
  return M.target === "wish" ? "Add wish" : "Add gift";
}

function inputStep(M, isWish) {
  return `
    <form class="sheet-body" data-form="modal-input" id="modalInput">
      <div class="field"><label for="giftIdea">${isWish ? "Wish" : "Gift idea"}</label>
        <input id="giftIdea" name="text" value="${esc(M.text)}" autocomplete="off" required ${M.loading ? "disabled" : ""}
          placeholder="${isWish ? "Something they've asked for, or a link" : "A gift idea, or a link to a product page"}"></div>
      <p class="note" style="margin:0">Paste a link from a web shop and the name, price and picture are filled in for you.</p>
      ${M.loading ? `<div class="thinking">Reading the product page</div>` : ""}
      <div class="row sheet-actions">
        <button type="button" class="ghost" data-act="modal-close">Cancel</button>
        <button class="primary" type="submit" id="modalSubmit" ${M.loading ? "disabled" : ""}>${M.loading ? "Reading page…" : isUrl(M.text) ? "Get details" : "Next"}</button>
      </div>
    </form>`;
}

function detailsStep(M, isWish) {
  const it = M.item;
  const otherCurrency = it.price != null && it.currency && it.currency !== currency();
  return `
    <form class="sheet-body" data-form="modal-save" id="modalSave">
      ${M.notice ? `<p class="msg muted" style="margin:0">${esc(M.notice)}</p>` : ""}
      <div class="link-preview">
        ${safeUrl(it.image) ? `<img class="preview-img" src="${esc(it.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        <div class="link-fields">
          <div class="field"><label for="mdTitle">Name</label><input id="mdTitle" name="title" value="${esc(it.title)}" required></div>
          <div class="row">
            ${isWish ? "" : `<div class="field" style="flex:1 1 140px"><label for="mdStore">Store</label><input id="mdStore" name="store" value="${esc(it.store)}" placeholder="Where to buy it"></div>`}
            <div class="field" style="flex:0 1 130px"><label for="mdPrice">Price (${esc(currency())})</label>
              <input id="mdPrice" name="price" type="number" min="0" step="any" value="${otherCurrency || it.price == null ? "" : esc(it.price)}"></div>
          </div>
          ${otherCurrency ? `<p class="note" style="margin:0">Listed at ${esc(it.price)} ${esc(it.currency)}. Enter the price in ${esc(currency())}.</p>` : ""}
          ${it.fromLink && it.price == null ? `<p class="note" style="margin:0">No price on the page. Add it yourself if you know it.</p>` : ""}
          <div class="field"><label for="mdUrl">Link</label><input id="mdUrl" name="url" type="url" inputmode="url" value="${esc(it.url || "")}" placeholder="https://…"></div>
          ${isWish ? "" : `<div class="field"><label for="mdOcc">Occasion</label><select id="mdOcc" name="occasion">${occOpts(M.occasion)}</select></div>`}
        </div>
      </div>
      ${M.error ? `<div class="err">${esc(M.error)}</div>` : ""}
      <div class="row sheet-actions">
        ${M.editId
          ? `<button type="button" class="ghost danger" data-act="modal-delete" style="margin-right:auto">${isWish ? "Delete wish" : "Delete gift"}</button>
             <button type="button" class="ghost" data-act="modal-close">Cancel</button>`
          : `<button type="button" class="ghost" data-act="modal-back">Back</button>`}
        <button class="primary" type="submit">${esc(saveLabel(M))}</button>
      </div>
    </form>`;
}

function renderModal() {
  const M = ui.modal, dlg = $("#addDialog");
  if (!M) return;
  const p = D.people.find((x) => x.id === M.pid);
  if (!p) { closeModal(); return; }
  const isWish = M.target === "wish";
  const heading = M.editId ? (isWish ? (hiddenFromMe(p) ? "Edit your wish" : `Edit ${p.name}'s wish`) : `Edit gift for ${p.name}`)
    : isWish ? (hiddenFromMe(p) ? "Add to your wishlist" : `Add to ${p.name}'s wishlist`)
    : `Gift for ${p.name}${M.occasion ? ` · ${occasionLabel(M.occasion)}` : ""}`;
  dlg.innerHTML = `<div class="sheet">
    <div class="sheet-head"><h2 id="addTitle">${esc(heading)}</h2>
      <button class="ghost" data-act="modal-close" aria-label="Close">✕</button></div>
    ${M.step === "details" ? detailsStep(M, isWish) : inputStep(M, isWish)}</div>`;
}

function showModal(focusSel) {
  renderModal();
  const dlg = $("#addDialog");
  if (!dlg.open) dlg.showModal();
  $(focusSel)?.focus();
}

function openModal(pid, opts = {}) {
  ui.modal = { pid, target: opts.target || "gift", occasion: opts.occasion || "", text: opts.text || "", step: "input" };
  showModal("#giftIdea");
  if (isUrl(ui.modal.text)) readLink(ui.modal);
}

function openEdit(giftId) {
  const g = D.gifts.find((x) => x.id === giftId);
  if (!g) return;
  ui.modal = {
    pid: g.person_id, target: "gift", editId: g.id, occasion: occKey(g), step: "details",
    item: { title: g.title, store: g.store, price: Number(g.price) || null, currency: null, image: g.image_url, url: g.url },
  };
  showModal("#mdTitle");
}

function openEditWish(wishId) {
  const w = D.wishes.find((x) => x.id === wishId);
  if (!w) return;
  ui.modal = {
    pid: w.person_id, target: "wish", editId: w.id, step: "details",
    item: { title: w.text, store: "", price: Number(w.price) || null, currency: null, image: w.image_url, url: w.url },
  };
  showModal("#mdTitle");
}

function closeModal() {
  ui.modal = null;
  const dlg = $("#addDialog");
  if (dlg.open) dlg.close();
  dlg.innerHTML = "";
}

// Move to the details step with only the name filled in.
function toDetails(M, item, notice = "") {
  M.step = "details"; M.item = item; M.notice = notice; M.error = "";
  renderModal();
  const empty = ["#mdTitle", "#mdPrice"].find((s) => $(s) && !$(s).value);
  $(empty || "#mdPrice")?.focus();
}

async function readLink(M) {
  const url = M.text.trim();
  M.loading = true; renderModal();
  let item = null, error = "";
  try {
    const { data, error: err } = await sb.functions.invoke("fetch-product", { body: { url } });
    if (err) {
      error = "Couldn't read that page.";
      try { const b = await err.context.json(); if (b?.error) error = b.error; } catch {}
    } else item = data;
  } catch {
    error = "Couldn't read that page.";
  }
  if (ui.modal !== M) return; // closed or reopened meanwhile
  M.loading = false;
  if (item) toDetails(M, { ...item, fromLink: true });
  else toDetails(M, { title: "", store: "", price: null, image: null, url }, `${error} Fill in the details yourself.`);
}

async function saveModal(d) {
  const M = ui.modal, p = D.people.find((x) => x.id === M.pid);
  const title = d.title.trim(), url = (d.url || "").trim();
  if (!title) return;
  if (url && !isUrl(url)) {
    // Keep what was typed so the re-render only adds the message.
    Object.assign(M.item, { title, store: d.store ?? M.item.store, price: d.price === "" ? null : Number(d.price), currency: null, url });
    if (d.occasion !== undefined) M.occasion = d.occasion;
    M.error = "The link has to start with https:// or http://";
    renderModal(); $("#mdUrl")?.focus();
    return;
  }
  const price = Number(d.price) || 0;
  // Keep the picture only while the link it came from is unchanged.
  const image_url = url && url === M.item.url ? safeUrl(M.item.image) || null : null;
  if (M.target === "wish") {
    const fields = { text: title, price, url: url || null, image_url };
    if (M.editId) {
      replaceLocal(D.wishes, await run(sb.from("wishlist_items").update(fields).eq("id", M.editId).select().single()));
      toast("Saved changes");
    } else {
      D.wishes.push(await run(sb.from("wishlist_items").insert({ person_id: p.id, ...fields }).select().single()));
      toast(`Added to ${hiddenFromMe(p) ? "your" : `${p.name}'s`} wishlist`);
    }
  } else {
    const fields = { title, store: (d.store || "").trim(), price, url: url || null, image_url, ...occFields(d.occasion || "") };
    if (M.editId) {
      replaceLocal(D.gifts, await run(sb.from("gifts").update(fields).eq("id", M.editId).select().single()));
      toast("Saved changes");
    } else {
      D.gifts.push(await run(sb.from("gifts").insert({ person_id: p.id, ...fields }).select().single()));
      toast(`Added ${title} for ${p.name}`);
    }
  }
  closeModal();
  render();
}

// ---------- actions ----------
function focusOccOf(p) { const f = ui.filter[p.id] || "all"; return f !== "all" && f !== "none" ? f : ""; }

async function addGift(fields) {
  const row = await run(sb.from("gifts").insert(fields).select().single());
  D.gifts.push(row);
  render();
}

async function suggestFor(p) {
  ui.busy = p.id; ui.sugErr[p.id] = ""; render();
  try {
    const { data, error } = await sb.functions.invoke("suggest-gifts", {
      body: { personId: p.id, occasion: focusOccOf(p) || null, request: ui.prompt[p.id] || "" },
    });
    if (error) {
      let msg = "Couldn't get suggestions. Try again.";
      try { const b = await error.context.json(); if (b?.error) msg = b.error; } catch {}
      throw new Error(msg);
    }
    const items = (data?.suggestions || []).filter((s) => s && s.title).map((s) => ({
      title: String(s.title), why: String(s.why || ""), stores: Array.isArray(s.stores) ? s.stores.map(String) : [],
      localPrice: s.local_price ? String(s.local_price) : "", price: Number(s.price) || 0,
    }));
    if (!items.length) throw new Error("No suggestions came back. Try rewording your request.");
    ui.sug[p.id] = items;
  } catch (e) {
    ui.sugErr[p.id] = e.message;
  } finally {
    ui.busy = null; render();
  }
}

document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  if (act === "auth-switch") { ui.authMode = ui.authMode === "signin" ? "signup" : "signin"; renderAuth(); return; }
  if (act === "sign-out") { await sb.auth.signOut(); return; }
  if (!D) return;
  const p = person();
  try {
    switch (act) {
      case "select": sel = id; selOcc = null; ui.editing = false; render(); break;
      case "open-occ": selOcc = id; ui.editing = false; render(); break;
      case "filter": ui.filter[p.id] = b.dataset.v; render(); break;
      case "edit": ui.editing = true; render(); break;
      case "cancel-edit": ui.editing = false; render(); break;
      case "add-person": {
        const row = await run(sb.from("people").insert({ name: "New person" }).select().single());
        D.people.push(row); sel = row.id; selOcc = null; ui.editing = true; render();
        const f = $("#pfName"); if (f) { f.focus(); f.select(); }
        break;
      }
      case "del-person":
        if (!confirmClick(b, `Click again to remove ${p.name}`)) return;
        await run(sb.from("people").delete().eq("id", p.id));
        D.people = D.people.filter((x) => x.id !== p.id); sel = D.people[0]?.id || null; ui.editing = false; render();
        break;
      case "del-occ":
        if (!confirmClick(b, "Remove?")) return;
        await run(sb.from("occasions").delete().eq("id", id));
        for (const k in ui.filter) if (ui.filter[k] === id) ui.filter[k] = "all";
        if (selOcc === id) selOcc = null;
        await loadAll();
        break;
      case "del-wish":
        await run(sb.from("wishlist_items").delete().eq("id", id));
        D.wishes = D.wishes.filter((w) => w.id !== id); render();
        break;
      case "plan-wish": {
        const w = D.wishes.find((x) => x.id === id);
        await addGift({ person_id: p.id, title: w.text, price: Number(w.price) || 0, url: w.url, image_url: w.image_url, ...occFields(focusOccOf(p)) });
        await run(sb.from("wishlist_items").delete().eq("id", id));
        D.wishes = D.wishes.filter((x) => x.id !== id); render();
        break;
      }
      case "del-gift":
        await run(sb.from("gifts").delete().eq("id", id));
        D.gifts = D.gifts.filter((g) => g.id !== id); render();
        break;
      case "cycle": {
        const g = D.gifts.find((x) => x.id === id);
        const status = { idea: "bought", bought: "given", given: "idea" }[g.status];
        const patch = { status, bought_by: status === "idea" ? null : g.bought_by || me.id };
        replaceLocal(D.gifts, { ...g, ...patch }); render();
        replaceLocal(D.gifts, await run(sb.from("gifts").update(patch).eq("id", id).select().single())); render();
        break;
      }
      case "add-sug": {
        const s = ui.sug[p.id][Number(b.dataset.i)];
        s.added = true;
        await addGift({ person_id: p.id, title: s.title, store: s.stores.join(", "), price: Math.round(s.price), ...occFields(focusOccOf(p)) });
        break;
      }
      case "open-add": openModal(b.dataset.pid, { occasion: b.dataset.occ }); break;
      case "modal-close": closeModal(); break;
      case "modal-back":
        Object.assign(ui.modal, { step: "input", item: null, notice: "", error: "" });
        renderModal(); $("#giftIdea")?.focus();
        break;
      case "edit-gift": openEdit(id); break;
      case "edit-wish": openEditWish(id); break;
      case "modal-delete": {
        if (!confirmClick(b, "Click again to delete")) return;
        const { editId, target } = ui.modal;
        if (target === "wish") {
          await run(sb.from("wishlist_items").delete().eq("id", editId));
          D.wishes = D.wishes.filter((w) => w.id !== editId);
        } else {
          await run(sb.from("gifts").delete().eq("id", editId));
          D.gifts = D.gifts.filter((g) => g.id !== editId);
        }
        closeModal(); render(); toast(target === "wish" ? "Wish deleted" : "Gift deleted");
        break;
      }
      case "copy-code":
        try { await navigator.clipboard.writeText(b.dataset.code); toast(`Copied invite code ${b.dataset.code}`); }
        catch { toast(`Invite code: ${b.dataset.code}`); }
        break;
      case "leave-group":
        if (!confirmClick(b, "Click again to leave")) return;
        await run(sb.from("group_members").delete().eq("group_id", id).eq("user_id", me.id));
        await loadAll();
        break;
      case "del-group":
        if (!confirmClick(b, "Click again to delete")) return;
        await run(sb.from("groups").delete().eq("id", id));
        toast("Group deleted. Shared people and occasions are back to private for whoever added them.");
        await loadAll();
        break;
    }
  } catch { /* run() already showed the error */ }
});

document.addEventListener("submit", async (ev) => {
  const f = ev.target.closest("[data-form]");
  if (!f) return;
  ev.preventDefault();
  const d = Object.fromEntries(new FormData(f));

  if (f.dataset.form === "auth") {
    const btn = $("#authSubmit"); btn.disabled = true;
    try {
      if (ui.authMode === "signup") {
        const { data, error } = await sb.auth.signUp({
          email: d.email, password: d.password,
          options: { data: { display_name: (d.display_name || "").trim() }, emailRedirectTo: location.href.split("#")[0] },
        });
        if (error) renderAuth(error.message, true);
        else if (!data.session) { ui.authMode = "signin"; renderAuth(`We sent a confirmation link to ${d.email}. Open it, then sign in here.`); }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: d.email, password: d.password });
        if (error) renderAuth(error.message, true);
      }
    } finally { btn.disabled = false; }
    return;
  }
  if (!D) return;
  const p = person();
  try {
    switch (f.dataset.form) {
      case "occasion":
        await run(sb.from("occasions").insert({ name: d.name.trim(), date: d.date, group_id: d.group_id || null }));
        f.reset(); await loadAll();
        break;
      case "create-group": {
        const g = await run(sb.rpc("create_group", { group_name: d.name.trim() }));
        f.reset(); await loadAll();
        toast(`Created ${g.name}. Share the invite code ${g.invite_code} with the people you want in it.`);
        break;
      }
      case "join-group": {
        const g = await run(sb.rpc("join_group", { code: d.code }));
        f.reset(); await loadAll();
        toast(`You joined ${g.name}.`);
        break;
      }
      case "person": {
        const patch = { name: d.name.trim() || "Unnamed", relation: d.relation.trim(), country: d.country.trim(), birthday: d.birthday || null, budget: Number(d.budget) || 0 };
        if (p.owner_id === me.id) { patch.group_id = d.group_id || null; patch.member_id = patch.group_id ? d.member_id || null : null; }
        replaceLocal(D.people, await run(sb.from("people").update(patch).eq("id", p.id).select().single()));
        ui.editing = false;
        if (p.group_id !== patch.group_id && patch.group_id !== undefined) await loadAll(); else render();
        break;
      }
      case "modal-input": {
        const M = ui.modal, text = d.text.trim();
        if (!M || !text || M.loading) break;
        M.text = text;
        if (isUrl(text)) readLink(M);
        else toDetails(M, { title: text, store: "", price: null, image: null, url: null });
        break;
      }
      case "modal-save":
        if (ui.modal?.item) await saveModal(d);
        break;
      case "wish": {
        if (isUrl(d.text)) { f.reset(); openModal(p.id, { target: "wish", text: d.text.trim() }); break; }
        const row = await run(sb.from("wishlist_items").insert({ person_id: p.id, text: d.text.trim(), price: Number(d.price) || 0 }).select().single());
        D.wishes.push(row); render(); $("#wishText")?.focus();
        break;
      }
      case "suggest":
        ui.prompt[p.id] = d.prompt.trim();
        if (!ui.busy) suggestFor(p);
        break;
    }
  } catch { /* run() already showed the error */ }
});

document.addEventListener("change", async (ev) => {
  const el = ev.target;
  if (!D) return;
  try {
    if (el.id === "pfGroup") {
      const m = $("#pfMember");
      m.innerHTML = memberOpts(el.value, person().owner_id, "");
      m.disabled = !el.value;
    } else if (el.dataset.field === "likes") {
      const p = person();
      replaceLocal(D.people, await run(sb.from("people").update({ likes: el.value }).eq("id", p.id).select().single()));
      $("#saveState").textContent = "Saved to your account";
    } else if (el.dataset.giftOcc) {
      const row = await run(sb.from("gifts").update(occFields(el.value)).eq("id", el.dataset.giftOcc).select().single());
      replaceLocal(D.gifts, row); render();
    } else if (el.dataset.setting) {
      let v = el.value.trim();
      if (el.dataset.setting === "currency") v = v.toUpperCase();
      if (!v) { el.value = D.profile[el.dataset.setting] || ""; return; }
      const row = await run(sb.from("profiles").update({ [el.dataset.setting]: v }).eq("id", me.id).select().single());
      D.profile = D.profiles[me.id] = row; render();
    }
  } catch { /* run() already showed the error */ }
});
document.addEventListener("input", (ev) => {
  if (ev.target.id === "giftIdea" && ui.modal) {
    // The button says what will happen next: read a link, or go on to the details.
    ui.modal.text = ev.target.value;
    $("#modalSubmit").textContent = isUrl(ev.target.value) ? "Get details" : "Next";
    return;
  }
  if (sel && ev.target.id === "sugPrompt") ui.prompt[sel] = ev.target.value;
});

// The pane closes on Escape (native) and on a click on the backdrop.
const addDialog = $("#addDialog");
addDialog.addEventListener("close", () => { ui.modal = null; addDialog.innerHTML = ""; });
addDialog.addEventListener("click", (ev) => { if (ev.target === addDialog) closeModal(); });

// ---------- boot ----------
if (!sb) {
  $("#saveState").textContent = "Not connected";
  $("#authView").hidden = false;
  $("#authView").innerHTML = `<h2>Connect Supabase</h2><p class="msg">Add your project URL and anon key to <code>web/config.js</code>, then reload. The README has the full setup.</p>`;
} else {
  // Defer: running Supabase queries inside this callback can deadlock the auth lock.
  sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
}
