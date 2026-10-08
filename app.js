'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const main = $('#main'), sidebar = $('#sidebar'), popup = $('#popup'), dlg = $('#bulkDlg'), drawer = $('#drawer');

  const state = {
    data: null, fileName: '', indent: 4, eol: '\n', undo: [], redo: [], dirty: false,
    current: '__overview', views: {}, selected: new Set(), edited: new WeakMap(),
    ds: [], cache: null, vis: [], order: [], lastSel: -1, drawerApply: null,
  };

  const LABEL_KEYS = ['Name', 'name', 'AccessName', 'Title', 'title', 'Id', 'id', 'ID', 'Key', 'key'];
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  function getPath(o, p) { for (const k of p) { if (o == null) return undefined; o = o[k]; } return o; }
  function setPath(o, p, v) {
    for (let i = 0; i < p.length - 1; i++) { if (!isObj(o[p[i]])) o[p[i]] = {}; o = o[p[i]]; }
    o[p[p.length - 1]] = v;
  }
  function labelOf(o) {
    if (!isObj(o)) return '(item)';
    for (const k of LABEL_KEYS) if (o[k] !== undefined && o[k] !== '' && typeof o[k] !== 'object') return String(o[k]);
    for (const k in o) if (typeof o[k] === 'string' && o[k]) return o[k];
    return '(item)';
  }
  function display(v) {
    if (v === undefined) return '';
    if (v === null) return 'null';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  function cmp(a, b) {
    if (a === b) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return collator.compare(display(a), display(b));
  }
  function toast(msg, ms = 2500) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
  }
  function coerce(raw, type) {
    if (type === 'boolean') {
      const s = String(raw).trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'n', 'off', ''].includes(s)) return false;
      throw new Error(`"${raw}" is not a valid boolean (use true/false)`);
    }
    if (type === 'number') {
      const n = Number(raw);
      if (String(raw).trim() === '' || !Number.isFinite(n)) throw new Error(`"${raw}" is not a valid number`);
      return n;
    }
    if (type === 'strbool') return coerce(raw, 'boolean') ? 'True' : 'False';
    return String(raw);
  }
  // Many flags in this format are the strings "True"/"False"; they must stay strings in that exact casing.
  const isStrBool = v => v === 'True' || v === 'False';
  const isTrue = v => v === true || String(v).toLowerCase() === 'true';
  const typeOf = (cur, col) => (isStrBool(cur) ? 'strbool' : cur !== undefined && cur !== null ? (Array.isArray(cur) ? 'array' : typeof cur) : col.type);

  // "Name as item name": when on, ItemName follows the tag name; typing a different ItemName turns it off.
  // Returns the ItemDetails fields that were changed as a side effect.
  function syncItemName(o, changedKey, tagName) {
    const d = o?.IoConfig?.ItemDetails;
    if (!isObj(d)) return [];
    if (changedKey === 'UseTagNameAsItemName' && isTrue(d.UseTagNameAsItemName) && d.ItemName !== tagName) { d.ItemName = tagName; return ['ItemName']; }
    if (changedKey === 'ItemName' && isTrue(d.UseTagNameAsItemName) && d.ItemName !== tagName) {
      d.UseTagNameAsItemName = typeof d.UseTagNameAsItemName === 'boolean' ? false : 'False';
      return ['UseTagNameAsItemName'];
    }
    return [];
  }
  const itemKeyOf = path => (path.length === 3 && path[0] === 'IoConfig' && path[1] === 'ItemDetails' ? path[2] : null);

  // ---------- data model ----------
  function datasets() {
    const d = state.data, out = [];
    const tops = Array.isArray(d)
      ? (d.every(isObj) ? [['(root)', () => state.data]] : [])
      : Object.keys(d).filter(k => Array.isArray(d[k]) && d[k].every(isObj)).map(k => [k, () => state.data[k]]);
    for (const [name, getArr] of tops) {
      out.push({ id: name, label: name, getArr, rows: () => getArr().map(o => ({ obj: o, arr: getArr() })) });
      const nested = [];
      for (const it of getArr())
        for (const k in it)
          if (Array.isArray(it[k]) && it[k].length && it[k].every(isObj) && !nested.includes(k)) nested.push(k);
      for (const k of nested) {
        out.push({
          id: `${name} › ${k}`, label: k, parentId: name, parentLabel: name, nestedKey: k, isNested: true,
          rows: () => getArr().flatMap(p => (Array.isArray(p[k]) ? p[k].map(o => ({ obj: o, arr: p[k], parent: p })) : [])),
        });
      }
    }
    if (isUdtFile()) {
      const at = out.findLastIndex(d => d.id === 'Instances' || d.parentId === 'Instances') + 1 || out.length;
      out.splice(at, 0, {
        id: 'Instances › Members', label: 'Members', parentId: 'Instances', parentLabel: 'Instances', nestedKey: 'Members',
        isNested: true, instanceView: true, classify: JSON.stringify(['InstanceType']), defaultGroup: '__parent',
        check: checkOverridePath, write: writeOverride,
        rows: () => listOf('Instances').flatMap(inst => resolveMembers(inst.TypeOf).map(({ m, owner }) => {
          const ov = findOverride(inst, m.Name), tag = `${inst.Name}.${m.Name}`, base = effectiveMember(m, null);
          const obj = { Tag: tag, InstanceType: inst.TypeOf, DefinedIn: owner.Name, Overridden: ov ? 'Yes' : '',
            ...effectiveMember(m, ov), ConfiguredProps: ov ? ov.ConfiguredProps : '' };
          // With "Name as item name" the instance's item name is its own tag name.
          syncItemName(base, 'UseTagNameAsItemName', tag);
          syncItemName(obj, 'UseTagNameAsItemName', tag);
          return { key: inst.Name + '\u0001' + m.Name, parent: inst, member: m, ov, base, obj };
        })),
      });
    }
    return out;
  }

  // ---------- per-instance member overrides ----------
  const OVR_FIELDS = ['IoConfig', 'TagComment', 'AlarmGroup', 'LogData', 'LogEvents', 'LocalTag', 'RetentiveValue', 'RetentiveParameters', 'MemoryConfig', 'AlarmConfiguration'];
  const OVR_EDITABLE = [...OVR_FIELDS, 'Val', 'Priority'];
  // ConfiguredProps bit per property, inferred from the two overrides in udtinfo_override.json — unverified.
  const OVR_BITS = [
    [/^Val\.DefValue$/, 1], [/^LogData$/, 2], [/^LogEvents$/, 3], [/\.InputConversion$/, 4], [/\.OnMsg$/, 7], [/\.OffMsg$/, 8],
    [/ItemDetails\.AccessName$/, 9], [/ItemDetails\.ItemName$/, 10], [/ItemDetails\.UseTagNameAsItemName$/, 15], [/^TagComment$/, 16],
    [/AlarmSettings\.AlarmComment$/, 18], [/AlarmSettings\.AlarmState$/, 22], [/AlarmSettings\.Inhibitor$/, 23], [/AlarmSettings\.Priority$/, 24],
    [/^AlarmConfiguration\.IsAlarmEnabled$/, 63], [/DataValues\.Deadband\./, 20], [/DataValues\.LogDeadband\./, 21], [/DataValues\.EngUnits$/, 25],
    [/DataValues\.(MinEu|MinValue)\./, 28], [/DataValues\.(MaxEu|MaxValue)\./, 29], [/DataValues\.MinRaw\./, 30], [/DataValues\.MaxRaw\./, 31],
  ];

  const findOverride = (inst, name) => (Array.isArray(inst.Overrides) ? inst.Overrides.find(o => o.Name === name) : undefined);

  function defaultVal(m) {
    const mc = m.MemoryConfig, iv = (mc?.DiscreteDataValues || mc?.AnalogDataValues || m.IoConfig?.IOAnalogDataValues)?.InitialValue;
    if (iv) return structuredClone(iv);
    if (mc?.MessageDataValues) return { DataType: 'String', DefValue: mc.MessageDataValues.InitialValue ?? '' };
    return { DataType: m.TypeOf, DefValue: m.TypeOf === 'String' ? '' : '0' };
  }

  // What the instance's member actually looks like: template member with the instance override applied.
  function effectiveMember(m, ov) {
    const e = structuredClone(m);
    e.Val = ov?.Val ? structuredClone(ov.Val) : defaultVal(m);
    e.Priority = ov?.Priority ?? '999';
    if (ov) for (const k of OVR_FIELDS) {
      if (ov[k] === undefined || (k === 'MemoryConfig' && m.Source !== 'Memory') || (k === 'IoConfig' && m.Source === 'Memory')) continue;
      e[k] = structuredClone(ov[k]);
    }
    return e;
  }

  // Same shape as the product export: a full copy of the member plus instance context.
  function newOverride(inst, m) {
    const o = { Name: m.Name, ContextName: inst.Name, DataType: m.TypeOf, Val: defaultVal(m) };
    if (m.IoConfig) o.IoConfig = structuredClone(m.IoConfig);
    for (const k of ['TagComment', 'AlarmGroup', 'LogData', 'LogEvents', 'LocalTag', 'RetentiveValue', 'RetentiveParameters']) o[k] = m[k];
    o.Priority = '999';
    o.MemoryConfig = structuredClone(m.MemoryConfig || defaultConfig('Memory', m.TypeOf).MemoryConfig);
    if (!m.MemoryConfig && m.TypeOf === 'Discrete') o.MemoryConfig.DiscreteDataValues.InitialValue.DefValue = 0;
    o.AlarmConfiguration = structuredClone(m.AlarmConfiguration || {});
    o.ConfiguredProps = '0';
    syncItemName(o, 'UseTagNameAsItemName', `${inst.Name}.${m.Name}`);
    return o;
  }

  function checkOverridePath(r, path) {
    if (!OVR_EDITABLE.includes(path[0]))
      throw new Error(`"${path.join('.')}" is defined by the template — change it in Templates › Members`);
    if (path[0] === 'MemoryConfig' && r.member.Source !== 'Memory') throw new Error(`${r.obj.Tag} is an I/O member — MemoryConfig does not apply`);
    if (path[0] === 'IoConfig' && r.member.Source === 'Memory') throw new Error(`${r.obj.Tag} is a memory member — IoConfig does not apply`);
  }

  function writeOverride(r, path, value) {
    let ov = findOverride(r.parent, r.member.Name);
    if (!ov) {
      ov = newOverride(r.parent, r.member);
      if (!Array.isArray(r.parent.Overrides)) r.parent.Overrides = [];
      r.parent.Overrides.push(ov);
    }
    if (!(path[0] in ov)) ov[path[0]] = structuredClone(getPath(r.base, [path[0]]) ?? {});
    setPath(ov, path, value);
    const touched = [path, ...syncItemName(ov, itemKeyOf(path), r.obj.Tag).map(k => ['IoConfig', 'ItemDetails', k])];
    for (const p of touched) {
      const bit = OVR_BITS.find(([rx]) => rx.test(p.join('.')))?.[1];
      if (bit !== undefined) ov.ConfiguredProps = (BigInt(ov.ConfiguredProps || '0') | (1n << BigInt(bit))).toString();
    }
  }

  function resetOverrides(rows) {
    rows = rows.filter(r => r.ov);
    if (!rows.length) return toast('No overridden members in selection');
    mutate(() => rows.forEach(r => { const a = r.parent.Overrides, i = a.indexOf(r.ov); if (i >= 0) a.splice(i, 1); }),
      `Reset ${rows.length} member(s) to template`);
  }

  function openOverrideJson(r) {
    openDrawer(`${r.obj.Tag} — instance override`, r.ov || newOverride(r.parent, r.member), p => {
      if (!isObj(p) || p.Name !== r.member.Name) throw new Error(`Must be a JSON object with "Name": "${r.member.Name}"`);
      if (!Array.isArray(r.parent.Overrides)) r.parent.Overrides = [];
      const i = r.parent.Overrides.findIndex(o => o.Name === r.member.Name);
      i >= 0 ? (r.parent.Overrides[i] = p) : r.parent.Overrides.push(p);
    });
  }

  // Members an instance gets from its template, following the derived-template chain to the base.
  function resolveMembers(name, seen = new Set()) {
    if (seen.has(name)) return [];
    seen.add(name);
    const t = listOf('Templates').find(x => x.Name === name);
    if (t) return (t.Members || []).map(m => ({ m, owner: t }));
    const d = listOf('Derived Templates').find(x => x.Name === name);
    if (!d) return [];
    return [...resolveMembers(d.TypeOf, seen), ...(d.Members || []).map(m => ({ m, owner: d }))];
  }

  function valByKey(key, r) { return key === '__parent' ? labelOf(r.parent) : getPath(r.obj, JSON.parse(key)); }

  function classifyKey(ds, rows) {
    if (ds.classify) return ds.classify;
    if (ds.isNested) return '__parent';
    if (rows.length < 3) return null;
    let best = null;
    for (const k of Object.keys(rows[0].obj)) {
      const vals = new Set(); let ok = true;
      for (const r of rows) { const x = r.obj[k]; if (typeof x !== 'string') { ok = false; break; } vals.add(x); }
      if (!ok || vals.size < 2 || vals.size > Math.min(30, rows.length / 3)) continue;
      const score = (/type|kind|categ|class|group/i.test(k) ? 100 : 0) - vals.size;
      if (!best || score > best.score) best = { k, score };
    }
    return best ? JSON.stringify([best.k]) : null;
  }

  function columnsFor(ds, rows) {
    const cols = [], seen = new Set();
    if (ds.isNested) cols.push({ key: '__parent', name: ds.parentLabel.replace(/s$/, ''), group: 'parent', virtual: true });
    const walk = (o, p) => {
      for (const k of Object.keys(o)) {
        const v = o[k], np = [...p, k];
        if (isObj(v) && Object.keys(v).length) walk(v, np);
        else {
          const key = JSON.stringify(np);
          if (!seen.has(key)) { seen.add(key); cols.push({ key, path: np, name: k, group: p.join('.') }); }
        }
      }
    };
    rows.forEach(r => walk(r.obj, []));
    // keep columns of the same top-level section together
    const topOrder = [];
    cols.forEach(c => { const t = c.virtual ? '' : c.path[0]; if (!topOrder.includes(t)) topOrder.push(t); });
    cols.forEach((c, i) => (c.i = i));
    cols.sort((a, b) => topOrder.indexOf(a.virtual ? '' : a.path[0]) - topOrder.indexOf(b.virtual ? '' : b.path[0]) || a.i - b.i);
    for (const c of cols) {
      const vals = new Set(); let type;
      for (const r of rows) {
        const v = valByKey(c.key, r);
        vals.add(display(v) + (v === undefined ? '\u0000' : ''));
        if (type === undefined && v !== undefined && v !== null) type = Array.isArray(v) ? 'array' : typeof v;
      }
      c.distinct = vals.size; c.type = type || 'string';
    }
    return cols;
  }
  const colTitle = c => (c.virtual ? c.name : c.path.join('.'));

  function view(id) {
    return (state.views[id] ||= { search: '', filters: {}, sort: null, groupBy: undefined, colVis: {}, hideUniform: undefined, collapsed: new Set(), preset: null });
  }
  function isVisible(c, v, n) {
    if (c.key in v.colVis) return v.colVis[c.key];
    if (c.virtual || LABEL_KEYS.includes(c.name)) return true;
    return !(v.hideUniform && n > 1 && c.distinct <= 1);
  }
  function isEdited(o, key) { const s = state.edited.get(o); return !!s && s.has(key); }
  function markEdited(o, key) { if (!state.edited.has(o)) state.edited.set(o, new Set()); state.edited.get(o).add(key); }

  // ---------- mutations / history ----------
  function mutate(fn, msg) {
    if (state.batch) { fn(); return; }
    const snap = JSON.stringify(state.data);
    try { fn(); } catch (e) { state.data = JSON.parse(snap); throw e; }
    state.undo.push(snap);
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
    state.dirty = true;
    refresh();
    if (msg) toast(msg);
  }
  // Runs several edits as one undo step; fn returns false (or throws) to roll everything back.
  function batch(fn, msg) {
    const snap = JSON.stringify(state.data);
    let ok;
    state.batch = true;
    try { ok = fn(); } catch (e) { ok = false; toast(e.message, 4000); } finally { state.batch = false; }
    if (!ok) { state.data = JSON.parse(snap); refresh(); return false; }
    if (snap === JSON.stringify(state.data)) { toast('No changes'); return false; }
    state.undo.push(snap);
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
    state.dirty = true;
    refresh();
    toast(msg);
    return true;
  }
  function undoRedo(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(state.data));
    state.data = JSON.parse(from.pop());
    state.selected.clear(); state.edited = new WeakMap();
    state.dirty = true;
    refresh();
  }

  // ---------- UDT member type conversion ----------
  const MEMBER_TYPES = ['Discrete', 'Int', 'Real', 'String'];
  const SOURCES = { Memory: 'Memory', Reference: 'I/O (Reference)' };
  const TYPE_KEYS = ['["TypeOf"]', '["Source"]'];
  const isMember = o => isObj(o) && o.TagType === 'AtomicTag' && 'TypeOf' in o && 'Source' in o;
  const dv = (DataType, DefValue) => ({ DataType, DefValue });
  const num = v => { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) ? n : undefined; };

  function normType(v) {
    const t = MEMBER_TYPES.find(x => x.toLowerCase() === String(v).trim().toLowerCase());
    if (!t) throw new Error(`"${v}" is not a member type. Use: ${MEMBER_TYPES.join(', ')}`);
    return t;
  }
  function normSource(v) {
    const s = String(v).trim().toLowerCase();
    if (s === 'memory') return 'Memory';
    if (['reference', 'io', 'i/o'].includes(s)) return 'Reference';
    throw new Error(`"${v}" is not a member source. Use: Memory, Reference`);
  }

  // Defaults mirror what the product exports for a freshly created member of each kind.
  function defaultConfig(source, type) {
    const real = type === 'Real', t = real ? 'Real' : 'Int';
    if (source === 'Memory') {
      if (type === 'Discrete') return { MemoryConfig: { DataType: 'Discrete', DiscreteDataValues: { InitialValue: dv('Discrete', '0'), OnMsg: '', OffMsg: '' } } };
      if (type === 'String') return { MemoryConfig: { DataType: 'String', MessageDataValues: { InitialValue: '' } } };
      return { MemoryConfig: { DataType: type, AnalogDataValues: {
        InitialValue: dv('Int', real ? '0.0' : 0), EngUnits: '', Deadband: dv(t, 0), LogDeadband: dv(t, 0),
        MinValue: dv(t, -32768), MaxValue: dv(t, real ? 32768 : 32767) } } };
    }
    const item = { AccessName: '0', ItemName: '', UseTagNameAsItemName: 'False' };
    if (type === 'Discrete') return { IoConfig: { IODiscreteDataValues: { InputConversion: 190, WriteOption: 1, OnMsg: '', OffMsg: '' }, ItemDetails: item } };
    if (type === 'String') return { IoConfig: { IOMessageDataValues: { MaximumLength: 131, WriteOption: 1 }, ItemDetails: item } };
    return { IoConfig: { IOAnalogDataValues: {
      InitialValue: dv('Int', real ? '0.0' : '0'), EngUnits: '', Deadband: dv(t, 0), LogDeadband: dv(t, 0),
      MinRaw: dv(t, -32768), MaxRaw: dv(t, 32768), MinEu: dv(t, -32768), MaxEu: dv(t, 32768),
      Scaling: 'Linear', WriteOption: 'ReadWrite' }, ItemDetails: item } };
  }

  function carrySettings(from, to, type) {
    const fm = from.MemoryConfig, fi = from.IoConfig, tm = to.MemoryConfig, ti = to.IoConfig;
    const fa = fm?.AnalogDataValues || fi?.IOAnalogDataValues, ta = tm?.AnalogDataValues || ti?.IOAnalogDataValues;
    if (fa && ta) {
      const conv = (s, d) => {
        const n = s && d ? num(s.DefValue) : undefined;
        if (n === undefined) return;
        const v = type === 'Int' ? Math.round(n) : n;
        d.DefValue = typeof d.DefValue === 'string' ? (type === 'Real' && Number.isInteger(v) ? v.toFixed(1) : String(v)) : v;
      };
      if (typeof fa.EngUnits === 'string') ta.EngUnits = fa.EngUnits;
      ['InitialValue', 'Deadband', 'LogDeadband', 'MinRaw', 'MaxRaw'].forEach(k => conv(fa[k], ta[k]));
      conv(fa.MinValue || fa.MinEu, ta.MinValue || ta.MinEu);
      conv(fa.MaxValue || fa.MaxEu, ta.MaxValue || ta.MaxEu);
      if (fa.Scaling !== undefined && ta.Scaling !== undefined) ta.Scaling = fa.Scaling;
      if (fa.WriteOption !== undefined && ta.WriteOption !== undefined) ta.WriteOption = fa.WriteOption;
    }
    const fd = fm?.DiscreteDataValues || fi?.IODiscreteDataValues, td = tm?.DiscreteDataValues || ti?.IODiscreteDataValues;
    if (fd && td) {
      ['OnMsg', 'OffMsg', 'InputConversion', 'WriteOption'].forEach(k => { if (fd[k] !== undefined && td[k] !== undefined) td[k] = fd[k]; });
      if (fd.InitialValue && td.InitialValue) td.InitialValue = structuredClone(fd.InitialValue);
    }
    const fs = fm?.MessageDataValues || fi?.IOMessageDataValues, ts = tm?.MessageDataValues || ti?.IOMessageDataValues;
    if (fs && ts) Object.keys(ts).forEach(k => { if (fs[k] !== undefined) ts[k] = fs[k]; });
    if (fi?.ItemDetails && ti) ti.ItemDetails = structuredClone(fi.ItemDetails);
  }

  // Rebuilds the member in place so key order and object identity are preserved.
  function convertMember(m, source, type, keep = true) {
    if (m.Source === source && m.TypeOf === type) return false;
    const cfg = defaultConfig(source, type), cfgKey = Object.keys(cfg)[0];
    if (keep) carrySettings(m, cfg, type);
    const entries = [];
    let placed = false;
    for (const k of Object.keys(m)) {
      if (k === 'MemoryConfig' || k === 'IoConfig') { if (!placed) entries.push([cfgKey, cfg[cfgKey]]); placed = true; continue; }
      entries.push([k, k === 'Source' ? source : k === 'TypeOf' ? type : m[k]]);
    }
    if (!placed) entries.splice(entries.findIndex(([k]) => k === 'TypeOf') + 1, 0, [cfgKey, cfg[cfgKey]]);
    for (const k of Object.keys(m)) delete m[k];
    entries.forEach(([k, v]) => (m[k] = v));
    TYPE_KEYS.forEach(k => markEdited(m, k));
    return true;
  }

  function openTypeDlg() {
    const rows = scopeRows().filter(r => isMember(r.obj));
    if (!rows.length) return toast('No UDT members in scope');
    const nSel = selectedVisible().length;
    const opts = list => list.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    dlg.innerHTML = `
      <h3 style="margin-top:0">Change member type</h3>
      <p>${nSel ? `<strong>${rows.length}</strong> selected member(s)` : `No selection — applies to <strong>all ${rows.length}</strong> filtered member(s)`}</p>
      <div class="row"><label>Source</label><select id="tSrc"><option value="">(keep current)</option>${opts(Object.entries(SOURCES))}</select></div>
      <div class="row"><label>Data type</label><select id="tType"><option value="">(keep current)</option>${opts(MEMBER_TYPES.map(t => [t, t]))}</select></div>
      <div class="row"><label></label><span><input type="checkbox" id="tKeep" checked> Keep compatible settings (eng. units, limits, deadbands, on/off messages, I/O item)</span></div>
      <p style="margin:10px 0 4px">Preview</p>
      <div class="preview" id="tPrev"></div>
      <div class="actions"><button class="btn" id="tCancel">Cancel</button><button class="btn primary" id="tApply">Apply</button></div>`;
    const target = m => [$('#tSrc', dlg).value || m.Source, $('#tType', dlg).value || m.TypeOf];
    const kind = (s, t) => `${s === 'Reference' ? 'I/O' : s} ${t}`;
    const update = () => {
      const lines = []; let n = 0;
      rows.forEach(r => {
        const [s, t] = target(r.obj);
        if (s === r.obj.Source && t === r.obj.TypeOf) return;
        n++;
        if (lines.length < 12) lines.push(`${esc(r.parent ? labelOf(r.parent) + ' / ' : '')}${esc(labelOf(r.obj))}: <s>${esc(kind(r.obj.Source, r.obj.TypeOf))}</s> → <strong>${esc(kind(s, t))}</strong>`);
      });
      $('#tPrev', dlg).innerHTML = `<div>${n} of ${rows.length} member(s) will change</div>` + lines.join('<br>');
    };
    dlg.onchange = update;
    dlg.oninput = null;
    $('#tCancel', dlg).onclick = () => dlg.close();
    $('#tApply', dlg).onclick = () => {
      const keep = $('#tKeep', dlg).checked;
      const todo = rows.filter(r => { const [s, t] = target(r.obj); return s !== r.obj.Source || t !== r.obj.TypeOf; });
      if (!todo.length) return toast('No changes');
      const targets = todo.map(r => target(r.obj));
      mutate(() => todo.forEach((r, i) => convertMember(r.obj, ...targets[i], keep)), `Converted ${todo.length} member(s)`);
      dlg.close();
    };
    update();
    dlg.showModal();
  }

  // ---------- create templates / derived templates / instances / members ----------
  const CREATE_LABELS = { template: 'New template…', derived: 'New derived template…', instances: 'New instances…', member: 'Add members…' };
  const isUdtFile = () => isObj(state.data) && Array.isArray(state.data.Templates);
  const listOf = key => (Array.isArray(state.data[key]) ? state.data[key] : []);
  const arrOf = key => (Array.isArray(state.data[key]) ? state.data[key] : (state.data[key] = []));

  function createKindsFor(ds) {
    if (!isUdtFile()) return [];
    if (ds.id === 'Templates') return ['template', 'member'];
    if (ds.id === 'Derived Templates') return ['derived', 'member'];
    if (ds.id === 'Instances') return ['instances'];
    if (ds.isNested && ds.nestedKey === 'Members') return ['member'];
    return [];
  }

  function validateNames(names, existing) {
    if (!names.length) return 'Enter at least one name';
    const taken = new Set(existing.map(n => String(n).toLowerCase())), seen = new Set();
    for (const n of names) {
      if (!/^[A-Za-z_][^\s.]*$/.test(n)) return `"${n}" is not a valid name (must start with a letter or _, no spaces or dots)`;
      const k = n.toLowerCase();
      if (taken.has(k)) return `"${n}" already exists`;
      if (seen.has(k)) return `"${n}" is listed twice`;
      seen.add(k);
    }
    return '';
  }

  function newMember(name, source, type, comment) {
    const m = { Name: name, TagType: 'AtomicTag', Source: source, TagComment: comment, AlarmGroup: '$System',
      LogData: 'False', LogEvents: 'False', LocalTag: false, RetentiveValue: false, RetentiveParameters: false, TypeOf: type };
    Object.assign(m, defaultConfig(source, type));
    m.AlarmConfiguration = { AckModel: 'Condition', IsAlarmEnabled: 'False', IsDeviationAlarmEnabled: 'False', IsROCAlarmEnabled: 'False' };
    return m;
  }

  function openCreate(kind) {
    const tpls = listOf('Templates'), derived = listOf('Derived Templates');
    const allNames = [...tpls, ...derived].map(t => t.Name);
    const owners = [...tpls.map(t => ['Templates', t]), ...derived.map(t => ['Derived Templates', t])];
    if (kind !== 'template' && !owners.length) return toast('Create a template first');

    // Pre-select the template the user is currently looking at or has selected.
    const v = state.cache && view(state.cache.ds.id);
    const selObj = state.cache ? selectedVisible().map(r => r.parent || r.obj).find(o => allNames.includes(o.Name)) : null;
    const defT = selObj?.Name || (v?.preset && allNames.includes(v.preset.value) ? v.preset.value : '');
    const tplOpts = (withNone) => (withNone ? '<option value="">(none — empty)</option>' : '') +
      owners.map(([k, t], i) => `<option value="${i}" ${t.Name === defT ? 'selected' : ''}>${esc(t.Name)}${k === 'Derived Templates' ? ' (derived)' : ''}</option>`).join('');
    const row = (label, html) => `<div class="row"><label>${label}</label>${html}</div>`;
    const namesBox = `${row('Names', '<textarea id="cNames" placeholder="One name per line"></textarea>')}
      ${row('Generate', '<input id="gP" placeholder="Prefix" style="flex:2"><input id="gF" type="number" value="1" title="Start" style="flex:1"><input id="gN" type="number" value="5" min="1" title="Count" style="flex:1"><input id="gD" type="number" value="2" min="1" title="Digits" style="flex:1"><button class="btn small" id="gGo">Add</button>')}
      <div class="muted" style="margin-left:98px">Prefix · start · count · digits, e.g. PC_ 1 5 2 → PC_01 … PC_05</div>`;

    const body = {
      template: row('Name', '<input id="cName">') + row('Comments', '<input id="cComm">') + row('Copy members', `<select id="cCopy">${tplOpts(true)}</select>`),
      derived: row('Name', '<input id="cName">') + row('Comments', '<input id="cComm">') + row('Base template', `<select id="cBase">${tplOpts(false)}</select>`),
      instances: row('Template', `<select id="cBase">${tplOpts(false)}</select>`) + namesBox + row('Comments', '<input id="cComm">'),
      member: row('Template', `<select id="cBase">${tplOpts(false)}</select>`) + namesBox +
        row('Source', `<select id="cSrc">${Object.entries(SOURCES).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>`) +
        row('Data type', `<select id="cType">${MEMBER_TYPES.map(t => `<option>${t}</option>`).join('')}</select>`) + row('Comment', '<input id="cComm">'),
    }[kind];

    dlg.innerHTML = `<h3 style="margin-top:0">${CREATE_LABELS[kind].replace('…', '')}</h3>${body}
      <div id="cErr" class="err"></div>
      <div class="actions"><button class="btn" id="cCancel">Cancel</button><button class="btn primary" id="cApply">Create</button></div>`;
    dlg.onchange = null; dlg.oninput = null;
    const val = id => ($('#' + id, dlg)?.value ?? '').trim();
    const gGo = $('#gGo', dlg);
    if (gGo) gGo.onclick = () => {
      const from = parseInt(val('gF'), 10) || 0, n = Math.min(parseInt(val('gN'), 10) || 0, 1000), dig = parseInt(val('gD'), 10) || 1;
      const ta = $('#cNames', dlg), gen = Array.from({ length: n }, (_, i) => val('gP') + String(from + i).padStart(dig, '0'));
      ta.value = [ta.value.trim(), ...gen].filter(Boolean).join('\n');
    };
    $('#cCancel', dlg).onclick = () => dlg.close();
    $('#cApply', dlg).onclick = () => {
      const single = kind === 'template' || kind === 'derived';
      const names = single ? [val('cName')].filter(Boolean) : $('#cNames', dlg).value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const owner = owners[+val('cBase')];
      const base = kind === 'member' && owner[0] === 'Derived Templates' ? owners.find(([, t]) => t.Name === owner[1].TypeOf)?.[1] : null;
      const existing = kind === 'instances' ? listOf('Instances').map(i => i.Name)
        : kind === 'member' ? [...(owner[1].Members || []), ...(base?.Members || [])].map(m => m.Name) : allNames;
      const err = validateNames(names, existing);
      if (err) { $('#cErr', dlg).textContent = err; return; }

      const created = [], comm = val('cComm');
      let target, preset = null;
      mutate(() => {
        if (kind === 'template') {
          const src = owners[+val('cCopy')]?.[1];
          created.push({ Name: names[0], Comments: comm, Members: src ? structuredClone(src.Members || []) : [], Overrides: [] });
          arrOf('Templates').push(...created); target = 'Templates';
        } else if (kind === 'derived') {
          created.push({ Name: names[0], Comments: comm, TypeOf: owner[1].Name, Members: [], Overrides: [] });
          arrOf('Derived Templates').push(...created); target = 'Derived Templates';
        } else if (kind === 'instances') {
          names.forEach(n => created.push({ Name: n, Comments: comm, TypeOf: owner[1].Name, Overrides: [] }));
          arrOf('Instances').push(...created); target = 'Instances';
        } else {
          names.forEach(n => created.push(newMember(n, val('cSrc'), val('cType'), comm)));
          if (!Array.isArray(owner[1].Members)) owner[1].Members = [];
          owner[1].Members.push(...created);
          target = `${owner[0]} › Members`; preset = { key: '__parent', value: owner[1].Name };
        }
      }, `Created ${names.length} item(s)`);
      dlg.close();
      navigate(target, preset);
      state.selected = new Set(created);
      refresh();
    };
    dlg.showModal();
    $('input, textarea', dlg)?.focus();
  }

  function setCells(rows, c, fn) {
    const changes = [], ds = state.cache?.ds;
    try {
      rows.forEach((r, i) => {
        const cur = getPath(r.obj, c.path);
        const nv = fn(r, cur, i);
        if (!Object.is(nv, cur)) changes.push([r, nv]);
      });
      if (changes.length && ds?.write) {
        const okRows = changes.filter(([r]) => { try { ds.check(r, c.path); return true; } catch { return false; } });
        if (!okRows.length) ds.check(changes[0][0], c.path);
        const skipped = changes.length - okRows.length;
        const unmapped = !OVR_BITS.some(([rx]) => rx.test(c.path.join('.')));
        mutate(() => okRows.forEach(([r, nv]) => ds.write(r, c.path, nv)),
          `Overrode ${c.name} on ${okRows.length} instance member(s)` + (skipped ? ` — skipped ${skipped} where it doesn't apply` : '') +
          (unmapped ? ' — note: no known ConfiguredProps bit for this property' : ''));
        return true;
      }
      if (changes.length && TYPE_KEYS.includes(c.key) && changes.every(([r]) => isMember(r.obj))) {
        const isType = c.key === TYPE_KEYS[0];
        const targets = changes.map(([r, nv]) => (isType ? [r.obj.Source, normType(nv)] : [normSource(nv), r.obj.TypeOf]));
        mutate(() => changes.forEach(([r], i) => convertMember(r.obj, ...targets[i])), `Converted ${changes.length} member(s)`);
        return true;
      }
    } catch (e) { toast(e.message, 4000); return false; }
    if (!changes.length) { toast('No changes'); return true; }
    mutate(() => changes.forEach(([r, nv]) => {
      const old = getPath(r.obj, c.path);
      setPath(r.obj, c.path, nv); markEdited(r.obj, c.key);
      if (isMember(r.obj) && itemKeyOf(c.path))
        syncItemName(r.obj, itemKeyOf(c.path), r.obj.Name).forEach(k => markEdited(r.obj, JSON.stringify(['IoConfig', 'ItemDetails', k])));
      if (c.key !== '["Name"]') return;
      // Keep instance overrides linked when an instance or a template member is renamed.
      if (ds?.id === 'Instances') (r.obj.Overrides || []).forEach(o => { o.ContextName = nv; syncItemName(o, 'UseTagNameAsItemName', `${nv}.${o.Name}`); });
      else if (isMember(r.obj)) {
        syncItemName(r.obj, 'UseTagNameAsItemName', nv);
        listOf('Instances').forEach(inst => {
          const o = findOverride(inst, old);
          if (o && resolveMembers(inst.TypeOf).some(x => x.m === r.obj)) { o.Name = nv; syncItemName(o, 'UseTagNameAsItemName', `${inst.Name}.${nv}`); }
        });
      }
    }), `Updated ${changes.length} cell(s)`);
    return true;
  }

  const selKey = r => r.key ?? r.obj;
  const selectedVisible = () => state.vis.filter(r => state.selected.has(selKey(r)));
  const scopeRows = () => { const s = selectedVisible(); return s.length ? s : state.vis; };

  function deleteRows(rows) {
    if (!rows.length) return toast('Select rows first');
    if (!confirm(`Delete ${rows.length} row(s)?`)) return;
    mutate(() => rows.forEach(r => { const i = r.arr.indexOf(r.obj); if (i >= 0) r.arr.splice(i, 1); }), `Deleted ${rows.length} row(s)`);
    state.selected.clear();
    refresh();
  }
  function duplicateRows(rows) {
    if (!rows.length) return toast('Select rows first');
    const clones = [];
    mutate(() => rows.forEach(r => {
      const c = structuredClone(r.obj);
      const lk = LABEL_KEYS.find(k => typeof c[k] === 'string');
      if (lk) c[lk] += '_copy';
      r.arr.splice(r.arr.indexOf(r.obj) + 1, 0, c);
      clones.push(c);
    }), `Duplicated ${rows.length} row(s) — the copies are now selected`);
    state.selected = new Set(clones);
    refresh();
  }

  // ---------- loading / saving ----------
  function loadText(text, name) {
    text = text.replace(/^\uFEFF/, '');
    let data;
    try { data = JSON.parse(text); } catch (e) { toast('Invalid JSON: ' + e.message, 5000); return; }
    if (!isObj(data) && !Array.isArray(data)) { toast('Top-level JSON must be an object or array', 4000); return; }
    const m = text.match(/^[[{]\r?\n([ \t]+)/);
    Object.assign(state, {
      data, fileName: name, indent: m ? m[1] : /^[[{]\s*\n/.test(text) ? 2 : '', eol: text.includes('\r\n') ? '\r\n' : '\n',
      undo: [], redo: [], dirty: false, current: '__overview', views: {}, selected: new Set(), edited: new WeakMap(), cellSel: null,
    });
    $('#fileName').textContent = name;
    refresh();
  }
  function readFile(file) {
    if (!file) return;
    if (state.dirty && !confirm('Discard unsaved changes and open another file?')) return;
    file.text().then(t => loadText(t, file.name));
  }
  function download(content, name, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function saveJson() {
    if (!state.data) return;
    // Real values must keep a decimal point (e.g. 0.0), which JSON.stringify drops.
    const MARK = '\u2063REAL\u2063';
    const text = JSON.stringify(state.data, function (k, v) {
      return k === 'DefValue' && this.DataType === 'Real' && Number.isInteger(v) ? MARK + v : v;
    }, state.indent).replace(new RegExp(`"${MARK}(-?\\d+)"`, 'g'), '$1.0').replace(/\n/g, state.eol);
    download(text, state.fileName || 'data.json', 'application/json');
    state.dirty = false; updateTopbar();
  }
  function exportCsv() {
    if (!state.cache || state.current === '__overview') return;
    const { ds, visCols } = state.cache;
    const q = v => {
      let s = display(v);
      if (/^[=+@\t\r]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [visCols.map(c => q(colTitle(c))).join(',')];
    state.order.forEach(i => lines.push(visCols.map(c => q(valByKey(c.key, state.vis[i]))).join(',')));
    const base = (state.fileName || 'data').replace(/\.json$/i, '');
    download('\uFEFF' + lines.join('\r\n'), `${base}_${ds.id.replace(/[^\w-]+/g, '_')}.csv`, 'text/csv');
  }

  // ---------- rendering ----------
  function refresh() {
    if (!state.data) return;
    state.ds = datasets();
    renderSidebar();
    renderMain();
    updateTopbar();
  }
  function updateTopbar() {
    $('#undoBtn').disabled = !state.undo.length;
    $('#redoBtn').disabled = !state.redo.length;
    $('#saveBtn').disabled = !state.data;
    $('#csvBtn').disabled = !state.data || state.current === '__overview';
    $('#dirty').hidden = !state.dirty;
  }

  function renderSidebar() {
    const h = [`<a data-nav="__overview" class="${state.current === '__overview' ? 'active' : ''}"><span>Overview</span></a>`, '<div class="sec">Tables</div>'];
    for (const ds of state.ds) {
      const rows = ds.rows(), v = state.views[ds.id], cur = state.current === ds.id;
      h.push(`<a data-nav="${esc(ds.id)}" class="${ds.isNested ? 'sub' : ''} ${cur && !(v && v.preset) ? 'active' : ''}" title="${esc(ds.id)}"><span>${esc(ds.isNested ? '› ' + ds.label : ds.label)}</span><span class="count">${rows.length}</span></a>`);
      const ck = classifyKey(ds, rows);
      if (!ck) continue;
      const counts = new Map();
      rows.forEach(r => { const g = display(valByKey(ck, r)); counts.set(g, (counts.get(g) || 0) + 1); });
      for (const g of [...counts.keys()].sort(collator.compare)) {
        const act = cur && v && v.preset && v.preset.key === ck && v.preset.value === g;
        h.push(`<a data-nav="${esc(ds.id)}" data-pk="${esc(ck)}" data-pv="${esc(g)}" class="${ds.isNested ? 'sub2' : 'sub'} ${act ? 'active' : ''}"><span>${esc(g || '(empty)')}</span><span class="count">${counts.get(g)}</span></a>`);
      }
    }
    sidebar.innerHTML = h.join('');
  }

  function renderMain() {
    if (state.current === '__overview') return renderOverview();
    const ds = state.ds.find(d => d.id === state.current);
    if (!ds) { state.current = '__overview'; return renderOverview(); }
    renderTable(ds);
  }

  function renderOverview() {
    state.cache = null;
    const d = state.data;
    const keys = isObj(d) ? Object.keys(d) : [];
    const scal = keys.filter(k => d[k] === null || typeof d[k] !== 'object');
    const other = keys.filter(k => d[k] !== null && typeof d[k] === 'object' && !state.ds.some(x => x.id === k));
    const scalRows = scal.map(k => {
      const v = d[k];
      const inp = typeof v === 'boolean'
        ? `<input type="checkbox" data-root="${esc(k)}" ${v ? 'checked' : ''}>`
        : `<input data-root="${esc(k)}" value="${esc(display(v))}">`;
      return `<tr><td class="muted">${esc(k)}</td><td>${inp}</td></tr>`;
    }).join('');
    const cards = state.ds.map(ds => {
      const rows = ds.rows(), ck = classifyKey(ds, rows);
      let brk = '';
      if (ck) {
        const counts = new Map();
        rows.forEach(r => { const g = display(valByKey(ck, r)); counts.set(g, (counts.get(g) || 0) + 1); });
        brk = [...counts].sort((a, b) => b[1] - a[1]).map(([g, n]) => `<span class="tag">${esc(g || '(empty)')}: ${n}</span>`).join(' ');
      }
      return `<div class="card" data-nav="${esc(ds.id)}"><div class="muted">${esc(ds.id)}</div><div class="n">${rows.length}</div><div>${brk}</div></div>`;
    }).join('');
    main.innerHTML = `
      <h2 style="margin:0">${esc(state.fileName)}</h2>
      <div class="cards">${cards}</div>
      ${scal.length ? `<div class="panel"><h3 style="margin-top:0">File properties</h3><table class="kv">${scalRows}</table></div>` : ''}
      ${isUdtFile() ? `<div class="panel"><h3 style="margin-top:0">Create</h3>${Object.entries(CREATE_LABELS).map(([k, l]) => `<button class="btn primary" data-create="${k}">${l}</button>`).join(' ')}</div>` : ''}
      <div class="panel">
        ${other.map(k => `<button class="btn" data-rawsec="${esc(k)}">Edit “${esc(k)}” as JSON</button>`).join(' ')}
        <button class="btn" id="rawAll">Edit whole file as JSON</button>
      </div>`;
  }

  function renderTable(ds) {
    const wrap = $('.tablewrap', main);
    const scroll = wrap && state.cache && state.cache.ds.id === ds.id ? [wrap.scrollTop, wrap.scrollLeft] : [0, 0];
    const v = view(ds.id), all = ds.rows(), cols = columnsFor(ds, all);
    if (v.groupBy === undefined) v.groupBy = ds.defaultGroup ?? (classifyKey(ds, all) || '');
    if (v.hideUniform === undefined) v.hideUniform = cols.length > 12 && all.length > 1;
    const visCols = cols.filter(c => isVisible(c, v, all.length));
    state.cache = { ds, all, cols, visCols };

    const presetCol = v.preset && cols.find(c => c.key === v.preset.key);
    const groupOpts = cols.filter(c => c.type !== 'array' && c.type !== 'object')
      .map(c => `<option value="${esc(c.key)}" ${c.key === v.groupBy ? 'selected' : ''}>${esc(colTitle(c))} (${c.distinct})</option>`).join('');
    const th = visCols.map((c, j) => {
      const s = v.sort && v.sort.key === c.key ? (v.sort.dir > 0 ? ' ▲' : ' ▼') : '';
      return `<th data-sort="${esc(c.key)}" class="${s ? 'sorted' : ''}" title="${esc(colTitle(c))} — ${c.type}, ${c.distinct} distinct value(s)"><span class="grp">${esc(c.group) || '&nbsp;'}</span>${esc(c.name)}${s}<span class="colsel" data-colsel="${j}" title="Select all cells in this column (Shift+click to extend across columns · Ctrl+Space)">⬇</span>${!c.virtual && c.type !== 'array' && c.type !== 'object' && (!ds.instanceView || OVR_EDITABLE.includes(c.path[0])) ? `<span class="colsel" data-colbulk="${j}" title="Bulk edit this column (selected cells / rows, or all filtered rows)">✎</span>` : ''}</th>`;
    }).join('');
    const fr = visCols.map(c => `<th><input data-filter="${esc(c.key)}" value="${esc(v.filters[c.key] || '')}" placeholder="filter" title="text = contains, =text = exact, !text = does not contain"></th>`).join('');

    main.innerHTML = `
      <div class="toolbar">
        <h3 style="margin:0 6px 0 0">${esc(ds.id)}</h3>
        <span id="rowCount" class="muted"></span>
        ${presetCol ? `<span class="chip on" id="clearPreset" title="Remove this filter">${esc(presetCol.name)} = ${esc(v.preset.value || '(empty)')}<span class="x">×</span></span>` : ''}
        <div class="spacer"></div>
        <input type="search" id="search" placeholder="Search visible columns…" value="${esc(v.search)}">
        <label>Group by <select id="groupBy"><option value="">(none)</option>${groupOpts}</select></label>
        <button class="btn" id="colBtn">Columns ${visCols.length}/${cols.length} ▾</button>
        <label title="Hide columns whose value is identical in every row"><input type="checkbox" id="hideUni" ${v.hideUniform ? 'checked' : ''}> Hide uniform columns</label>
        <button class="btn" id="clearFilters">Clear filters</button>
        ${ds.getArr ? '<button class="btn" id="rawDs">Raw JSON</button>' : ''}
      </div>
      <div class="toolbar">
        <span id="selInfo" class="selinfo"></span>
        ${ds.instanceView ? `<button class="btn primary" id="bulkBtn">Bulk edit…</button>
        <button class="btn" id="resetOvBtn" title="Remove the instance override so the member follows its template again">Reset to template</button>
        <span class="muted">Edits are stored as overrides on the instance (<span class="overridden">&nbsp;highlighted&nbsp;</span> = differs from template). Structure/type: edit in <a href="#" data-nav-link="Templates › Members">Templates › Members</a>.</span>` : `
        ${createKindsFor(ds).map(k => `<button class="btn primary" data-create="${k}">${CREATE_LABELS[k]}</button>`).join('')}
        <button class="btn primary" id="bulkBtn">Bulk edit…</button>
        ${all.some(r => isMember(r.obj)) ? '<button class="btn primary" id="typeBtn" title="Convert members between Memory/I/O and Discrete/Int/Real/String">Change type…</button>' : ''}
        <button class="btn" id="dupBtn">Duplicate selected</button>
        <button class="btn danger" id="delBtn">Delete selected</button>`}
        <button class="btn" id="selNone">Clear selection</button>
        <span class="muted">Double-click a cell to edit · Click/drag/Shift+click cells or ⬇ in a header to select a column · Ctrl+Shift+End = to column end · Ctrl+C / Ctrl+V with Excel</span>
      </div>
      <div class="tablewrap">
        <table class="grid">
          <thead>
            <tr><th class="sticky"><input type="checkbox" id="selAll" title="Select all filtered rows"></th><th></th>${th}</tr>
            <tr class="filters"><th class="sticky"></th><th></th>${fr}</tr>
          </thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>`;
    renderBody();
    const w = $('.tablewrap', main);
    [w.scrollTop, w.scrollLeft] = scroll;
  }

  function matchFilter(s, f) {
    s = s.toLowerCase(); f = f.toLowerCase();
    if (f.startsWith('!')) return !s.includes(f.slice(1));
    if (f.startsWith('=')) return s === f.slice(1);
    return s.includes(f);
  }

  function cellHtml(c, j, r) {
    const val = valByKey(c.key, r);
    let cls = 'cell', html;
    if (val === undefined) { cls += ' empty'; html = ''; }
    else if (typeof val === 'boolean' || isStrBool(val)) { cls += ' bool'; html = `<input type="checkbox" data-bool ${isTrue(val) ? 'checked' : ''}>`; }
    else if (typeof val === 'number') { cls += ' num'; html = esc(val); }
    else if (Array.isArray(val)) html = `<span class="tag" data-arr title="Open">[${val.length}]</span>`;
    else if (val === null) html = '<span class="muted">null</span>';
    else if (isObj(val)) html = '<span class="tag" data-arr>{ }</span>';
    else html = esc(val);
    if (!c.virtual && isEdited(r.obj, c.key)) cls += ' edited';
    if (r.ov && !c.virtual && OVR_EDITABLE.includes(c.path[0]) && display(getPath(r.base, c.path)) !== display(val)) cls += ' overridden';
    const title = typeof val === 'string' && val.length > 30 ? ` title="${esc(val)}"` : '';
    return `<td class="${cls}" data-c="${j}"${title}>${html}</td>`;
  }

  function renderBody() {
    const { ds, all, visCols } = state.cache, v = view(ds.id);
    const s = v.search.trim().toLowerCase();
    const fs = Object.entries(v.filters).filter(([, f]) => f !== '');
    const rows = all.filter(r => {
      if (v.preset && display(valByKey(v.preset.key, r)) !== v.preset.value) return false;
      for (const [k, f] of fs) if (!matchFilter(display(valByKey(k, r)), f)) return false;
      if (s && !visCols.some(c => display(valByKey(c.key, r)).toLowerCase().includes(s))) return false;
      return true;
    });
    if (v.sort) rows.sort((a, b) => v.sort.dir * cmp(valByKey(v.sort.key, a), valByKey(v.sort.key, b)));
    state.vis = rows;

    const rowHtml = (r, i) => {
      const sel = state.selected.has(selKey(r));
      return `<tr data-r="${i}" class="${sel ? 'selected' : ''}"><td class="sticky"><input type="checkbox" data-sel ${sel ? 'checked' : ''}></td>` +
        `<td class="rowactions">${ds.instanceView ? `<button data-act="ovjson" title="Edit instance override as JSON">{ }</button>${r.ov ? '<button data-act="reset" title="Reset to template">↺</button>' : ''}` : `${ds.id === 'Instances' && isUdtFile() ? '<button data-act="members" title="Show this instance\'s members">≡</button>' : ''}<button data-act="json" title="Edit as JSON">{ }</button><button data-act="dup" title="Duplicate">⧉</button><button data-act="del" title="Delete">✕</button>`}</td>` +
        visCols.map((c, j) => cellHtml(c, j, r)).join('') + '</tr>';
    };
    const out = [], order = [];
    if (v.groupBy) {
      const gmap = new Map();
      rows.forEach((r, i) => { const g = display(valByKey(v.groupBy, r)); if (!gmap.has(g)) gmap.set(g, []); gmap.get(g).push(i); });
      for (const g of [...gmap.keys()].sort(collator.compare)) {
        const idx = gmap.get(g), collapsed = v.collapsed.has(g);
        const allSel = idx.every(i => state.selected.has(selKey(rows[i])));
        out.push(`<tr class="grouprow" data-g="${esc(g)}"><td class="sticky"><input type="checkbox" data-gsel ${allSel ? 'checked' : ''} title="Select group"></td><td colspan="${visCols.length + 1}">${collapsed ? '▸' : '▾'} <strong>${esc(g || '(empty)')}</strong> <span class="muted">${idx.length} row(s)</span></td></tr>`);
        idx.forEach(i => order.push(i));
        if (!collapsed) idx.forEach(i => out.push(rowHtml(rows[i], i)));
      }
    } else rows.forEach((r, i) => { order.push(i); out.push(rowHtml(r, i)); });
    state.order = order;
    state.shown = order.filter(i => !v.groupBy || !v.collapsed.has(display(valByKey(v.groupBy, rows[i]))));
    state.shownPos = new Map(state.shown.map((i, p) => [i, p]));
    if (!rows.length) out.push(`<tr><td colspan="${visCols.length + 2}" class="muted" style="padding:16px">No rows${all.length ? ' match the current filters' : ''}.</td></tr>`);
    $('#tbody').innerHTML = out.join('');
    $('#rowCount').textContent = `${rows.length} of ${all.length} rows`;
    updateSelInfo();
    paintSel();
  }

  // ---------- cell range selection + Excel copy/paste ----------
  function selRange() {
    const s = state.cellSel;
    if (!s || !state.cache) return null;
    return { p0: Math.min(s.a.p, s.f.p), p1: Math.max(s.a.p, s.f.p), c0: Math.min(s.a.c, s.f.c), c1: Math.max(s.a.c, s.f.c) };
  }
  function paintSel() {
    const tb = $('#tbody');
    if (!tb) return;
    tb.querySelectorAll('td.csel').forEach(td => td.classList.remove('csel'));
    const R = selRange();
    if (!R) return;
    for (let p = R.p0; p <= R.p1; p++) {
      const tr = tb.querySelector(`tr[data-r="${state.shown[p]}"]`);
      if (tr) for (let c = R.c0; c <= R.c1; c++) tr.querySelector(`td[data-c="${c}"]`)?.classList.add('csel');
    }
  }
  const cellPos = td => ({ p: state.shownPos.get(+td.parentElement.dataset.r), c: +td.dataset.c });

  // Why a pasted value can't go into this cell ('' = it can), e.g. an I/O setting on a memory member.
  function cellIssue(ds, r, path) {
    if (ds.check) try { ds.check(r, path); } catch (e) { return e.message; }
    if (getPath(r.obj, path) === undefined && path.length > 1 && !isObj(getPath(r.obj, path.slice(0, -1))))
      return `${path.join('.')} does not exist on ${r.obj.Tag || labelOf(r.obj)}`;
    return '';
  }

  const tsvCell = v => {
    const s = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : display(v);
    return /[\t\r\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  function parseTSV(text) {
    const rows = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch !== '"') f += ch;
        else if (text[i + 1] === '"') { f += '"'; i++; }
        else q = false;
      } else if (ch === '"' && f === '') q = true;
      else if (ch === '\t') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  function copyCells(e) {
    const R = selRange(), { visCols } = state.cache;
    const lines = [];
    for (let p = R.p0; p <= R.p1; p++) {
      const r = state.vis[state.shown[p]];
      if (!r) continue;
      const cells = [];
      for (let c = R.c0; c <= R.c1; c++) cells.push(tsvCell(valByKey(visCols[c].key, r)));
      lines.push(cells.join('\t'));
    }
    e.clipboardData.setData('text/plain', lines.join('\r\n'));
    e.preventDefault();
    toast(`Copied ${lines.length} × ${R.c1 - R.c0 + 1} cell(s)`);
  }

  function pasteCells(grid) {
    const R = selRange(), { visCols, ds } = state.cache;
    if (!grid.length) return;
    // A single copied value fills the whole selected range, like Excel.
    const single = grid.length === 1 && grid[0].length === 1;
    const wantR = single ? R.p1 - R.p0 + 1 : grid.length, wantC = single ? R.c1 - R.c0 + 1 : Math.max(...grid.map(g => g.length));
    const nR = Math.min(wantR, state.shown.length - R.p0), nC = Math.min(wantC, visCols.length - R.c0);
    const skipped = [], ops = [];
    let skippedCells = 0, firstIssue = '';
    for (let j = 0; j < nC; j++) {
      const c = visCols[R.c0 + j];
      if (c.virtual || c.type === 'array' || c.type === 'object') { skipped.push(c.name); continue; }
      const rows = [], vals = [];
      for (let i = 0; i < nR; i++) {
        const raw = single ? grid[0][0] : grid[i]?.[j];
        if (raw === undefined) continue;
        const r = state.vis[state.shown[R.p0 + i]], issue = cellIssue(ds, r, c.path);
        if (issue) { skippedCells++; firstIssue ||= issue; continue; }
        rows.push(r); vals.push(raw);
      }
      if (rows.length) ops.push([rows, c, vals]);
    }
    if (!ops.length) return toast(firstIssue ? `Nothing pasted: ${firstIssue}` : `Nothing pasted: ${skipped.join(', ')} can't be edited here`, 6000);
    const note = (skipped.length ? ` — skipped read-only: ${skipped.join(', ')}` : '') +
      (skippedCells ? ` — skipped ${skippedCells} cell(s) that don't apply (e.g. ${firstIssue})` : '') +
      (nR < wantR || nC < wantC ? ' — clipped to table edge' : '');
    const ok = batch(() => ops.every(([rows, c, vals]) =>
      setCells(rows, c, (r, cur, i) => (vals[i] === '' && cur === undefined ? cur : coerce(vals[i], typeOf(cur, c))))), `Pasted ${nR} × ${nC} cell(s)${note}`);
    if (ok) { state.cellSel = { a: { p: R.p0, c: R.c0 }, f: { p: R.p0 + nR - 1, c: R.c0 + nC - 1 } }; paintSel(); }
  }

  const tableHasCellFocus = () => {
    const a = document.activeElement;
    return state.cache && state.current !== '__overview' && selRange() && !dlg.open && !(a && a.matches('input, textarea, select'));
  };
  document.addEventListener('copy', e => { if (tableHasCellFocus()) copyCells(e); });
  document.addEventListener('paste', e => {
    if (!tableHasCellFocus()) return;
    e.preventDefault();
    pasteCells(parseTSV(e.clipboardData.getData('text/plain')));
  });
  main.addEventListener('mousedown', e => {
    const td = e.target.closest('td.cell');
    if (!td || e.button !== 0 || e.target.closest('input:not([data-bool]), button, .tag')) return;
    const pos = cellPos(td);
    if (e.shiftKey && state.cellSel) state.cellSel.f = pos; else state.cellSel = { a: pos, f: pos };
    state.dragging = true;
    // Let a plain click on a checkbox still toggle it.
    if (e.target.dataset.bool === undefined || e.shiftKey) e.preventDefault();
    document.activeElement?.blur?.();
    paintSel();
  });
  main.addEventListener('mouseover', e => {
    const td = state.dragging && e.target.closest('td.cell');
    if (td) { state.cellSel.f = cellPos(td); paintSel(); }
  });
  document.addEventListener('mouseup', () => (state.dragging = false));

  function selectColumns(c0, c1) {
    if (!state.shown?.length) return;
    state.cellSel = { a: { p: 0, c: c0 }, f: { p: state.shown.length - 1, c: c1 } };
    paintSel();
    showSelCount();
  }
  function showSelCount() {
    const R = selRange();
    if (R) toast(`${R.p1 - R.p0 + 1} × ${R.c1 - R.c0 + 1} cell(s) selected — Ctrl+C to copy, Ctrl+V to paste`);
  }
  document.addEventListener('keydown', e => {
    if (!state.cellSel || !state.cache || dlg.open || e.target.closest('input, textarea, select')) return;
    const s = state.cellSel, last = state.shown.length - 1, ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { state.cellSel = null; paintSel(); return; }
    // Excel-style: extend the selection to the bottom/top of the current column(s).
    if (ctrl && e.shiftKey && (e.key === 'End' || e.key === 'ArrowDown')) s.f = { p: last, c: s.f.c };
    else if (ctrl && e.shiftKey && (e.key === 'Home' || e.key === 'ArrowUp')) s.f = { p: 0, c: s.f.c };
    else if (ctrl && e.key === ' ') { s.a = { p: 0, c: s.a.c }; s.f = { p: last, c: s.f.c }; }
    else return;
    e.preventDefault();
    paintSel();
    $(`#tbody tr[data-r="${state.shown[s.f.p]}"] td[data-c="${s.f.c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    showSelCount();
  });

  function updateSelInfo() {
    const n = selectedVisible().length, t = state.vis.length;
    $('#selInfo').textContent = n ? `${n} selected` : `No selection — bulk edit applies to all ${t} filtered row(s)`;
    const sa = $('#selAll');
    sa.checked = n > 0 && n === t;
    sa.indeterminate = n > 0 && n < t;
  }

  // ---------- inline edit ----------
  function startEdit(td) {
    const r = state.vis[+td.parentElement.dataset.r], c = state.cache.visCols[+td.dataset.c];
    if (c.virtual) return toast('This column comes from the parent item and is read-only here');
    if (state.cache.ds.check) try { state.cache.ds.check(r, c.path); } catch (e) { return toast(e.message, 4000); }
    const cur = getPath(r.obj, c.path);
    if (typeof cur === 'boolean') return;
    if (cur !== null && typeof cur === 'object') return openRowJson(r);
    const orig = cur == null ? '' : String(cur);
    const inp = document.createElement('input');
    inp.className = 'inline'; inp.value = orig;
    td.textContent = ''; td.appendChild(inp); inp.focus(); inp.select();
    let done = false;
    const finish = (commit, allSel) => {
      if (done) return; done = true;
      if (!commit || (!allSel && inp.value === orig)) return renderBody();
      const targets = allSel ? [...new Set([r, ...selectedVisible()])] : [r];
      if (!setCells(targets, c, (_, cv) => coerce(inp.value, typeOf(cv, c)))) renderBody();
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true, e.ctrlKey); }
      else if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true, false));
  }

  // ---------- drawer (raw JSON) ----------
  function openDrawer(title, value, onApply) {
    $('#drawerTitle').textContent = title;
    $('#drawerText').value = JSON.stringify(value, null, 2);
    $('#drawerErr').textContent = '';
    state.drawerApply = onApply;
    drawer.hidden = false;
    $('#drawerText').focus();
  }
  function openRowJson(r) {
    openDrawer(labelOf(r.obj), r.obj, p => {
      if (!isObj(p)) throw new Error('Must be a JSON object');
      for (const k of Object.keys(r.obj)) delete r.obj[k];
      Object.assign(r.obj, p);
    });
  }

  // ---------- bulk edit ----------
  const OPS = {
    set: { label: 'Set value', types: ['string', 'number', 'boolean'], a: 'Value' },
    replace: { label: 'Find & replace', types: ['string', 'number'], a: 'Find', b: true, opts: true },
    prefix: { label: 'Add prefix', types: ['string'], a: 'Prefix' },
    suffix: { label: 'Add suffix', types: ['string'], a: 'Suffix' },
    pattern: { label: 'Set from pattern', types: ['string', 'number'], a: 'Pattern', help: 'Tokens: {value} current value, {#} row number, {parent} parent name, {Name} or {Any.Field.Path} another field of the row.' },
    add: { label: 'Add to number', types: ['number'], a: 'Amount' },
    toggle: { label: 'Toggle true/false', types: ['boolean'] },
    upper: { label: 'UPPERCASE', types: ['string'] },
    lower: { label: 'lowercase', types: ['string'] },
  };

  function bulkFn(op, c, A, B, useRe, cs) {
    const t = cur => typeOf(cur, c);
    switch (op) {
      case 'set': return (r, cur) => coerce(A, t(cur));
      case 'replace': {
        if (!A) throw new Error('Enter text to find');
        const rx = new RegExp(useRe ? A : A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'g' : 'gi');
        return (r, cur) => (cur == null ? cur : coerce(useRe ? String(cur).replace(rx, B) : String(cur).replace(rx, () => B), t(cur)));
      }
      case 'prefix': return (r, cur) => coerce(A + display(cur), t(cur));
      case 'suffix': return (r, cur) => coerce(display(cur) + A, t(cur));
      case 'pattern': return (r, cur, i) => coerce(A.replace(/\{([^}]+)\}/g, (m, tok) => {
        if (tok === 'value') return display(cur);
        if (tok === '#') return String(i + 1);
        if (tok === 'parent') return r.parent ? labelOf(r.parent) : '';
        let v = getPath(r.obj, tok.split('.'));
        if (v === undefined && r.parent) v = getPath(r.parent, tok.split('.'));
        return display(v);
      }), t(cur));
      case 'add': {
        const n = Number(A);
        if (A.trim() === '' || !Number.isFinite(n)) throw new Error('Enter a number');
        return (r, cur) => (typeof cur === 'number' ? cur + n : cur);
      }
      case 'toggle': return (r, cur) => (typeof cur === 'boolean' ? !cur : cur);
      case 'upper': return (r, cur) => (typeof cur === 'string' ? cur.toUpperCase() : cur);
      case 'lower': return (r, cur) => (typeof cur === 'string' ? cur.toLowerCase() : cur);
    }
  }

  function openBulk(fieldKey, scope) {
    const nSel = selectedVisible().length, { cols, visCols, ds } = state.cache;
    const rows = scope ? scope.rows : scopeRows();
    const editable = cols.filter(c => !c.virtual && c.type !== 'array' && c.type !== 'object');
    if (!rows.length || !editable.length) return toast('Nothing to edit');
    const v = view(ds.id);
    const def = editable.find(c => c.key === fieldKey) || editable.find(c => c.key === v.bulkField) || editable.find(c => visCols.includes(c) && !LABEL_KEYS.includes(c.name)) || editable[0];
    dlg.innerHTML = `
      <h3 style="margin-top:0">Bulk edit</h3>
      <p>${scope ? scope.label : nSel ? `<strong>${rows.length}</strong> selected row(s)` : `No selection — applies to <strong>all ${rows.length}</strong> filtered row(s)`}</p>
      <div class="row"><label>Field</label><select id="bField">${editable.map(c => `<option value="${esc(c.key)}" ${c === def ? 'selected' : ''}>${esc(colTitle(c))} · ${c.type}</option>`).join('')}</select></div>
      <div class="row"><label>Operation</label><select id="bOp"></select></div>
      <div class="row" id="rA"><label id="lA">Value</label><input id="bA"></div>
      <div class="row" id="rB"><label>Replace with</label><input id="bB"></div>
      <div class="row" id="rOpt"><label></label><span><input type="checkbox" id="bRe"> Regex</span><span><input type="checkbox" id="bCase"> Match case</span></div>
      <div id="bHelp" class="muted"></div>
      <p style="margin:10px 0 4px">Preview</p>
      <div class="preview" id="bPrev"></div>
      <div class="actions"><button class="btn" id="bCancel">Cancel</button><button class="btn primary" id="bApply">Apply</button></div>`;
    const col = () => editable.find(c => c.key === $('#bField', dlg).value);
    const fillOps = () => {
      const t = col().type, sel = $('#bOp', dlg), prev = sel.value;
      sel.innerHTML = Object.entries(OPS).filter(([, o]) => o.types.includes(t)).map(([k, o]) => `<option value="${k}">${o.label}</option>`).join('');
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    };
    const build = () => bulkFn($('#bOp', dlg).value, col(), $('#bA', dlg).value, $('#bB', dlg).value, $('#bRe', dlg).checked, $('#bCase', dlg).checked);
    const update = () => {
      const o = OPS[$('#bOp', dlg).value];
      $('#rA', dlg).hidden = !o.a; $('#lA', dlg).textContent = o.a || '';
      $('#rB', dlg).hidden = !o.b; $('#rOpt', dlg).hidden = !o.opts;
      $('#bHelp', dlg).textContent = o.help || (col().type === 'boolean' && o.a ? 'Enter true or false.' : '');
      const c = col(), prev = $('#bPrev', dlg);
      try {
        const fn = build(); let changed = 0; const lines = [];
        rows.forEach((r, i) => {
          const cur = getPath(r.obj, c.path), nv = fn(r, cur, i);
          if (!Object.is(nv, cur)) { changed++; if (lines.length < 12) lines.push(`${esc(labelOf(r.parent || {}) !== '(item)' ? labelOf(r.parent) + ' / ' : '')}${esc(labelOf(r.obj))}: <s>${esc(display(cur))}</s> → <strong>${esc(display(nv))}</strong>`); }
        });
        prev.innerHTML = `<div>${changed} of ${rows.length} value(s) will change</div>` + lines.join('<br>');
      } catch (e) { prev.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    };
    $('#bField', dlg).onchange = () => { fillOps(); update(); };
    $('#bOp', dlg).onchange = update;
    dlg.onchange = null;
    dlg.oninput = update;
    $('#bCancel', dlg).onclick = () => dlg.close();
    $('#bApply', dlg).onclick = () => {
      let fn;
      try { fn = build(); } catch (e) { return toast(e.message, 4000); }
      v.bulkField = col().key;
      if (setCells(rows, col(), fn)) dlg.close();
    };
    fillOps(); update();
    dlg.showModal();
    $('#bA', dlg).focus();
  }

  // ---------- column picker ----------
  function openColPicker(btn) {
    const { cols, ds, all } = state.cache, v = view(ds.id);
    const groups = new Map();
    cols.forEach(c => { const g = c.group || '(top level)'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); });
    popup.innerHTML = `
      <div style="display:flex;gap:4px;margin-bottom:6px">
        <button class="btn small" data-cp="all">Show all</button><button class="btn small" data-cp="none">Hide all</button><button class="btn small" data-cp="reset">Reset</button>
      </div>
      <input type="search" id="cpFilter" placeholder="Find column…" style="width:100%;margin-bottom:4px">
      ${[...groups].map(([g, cs]) => `<div class="grouphead">${esc(g)}</div>` + cs.map(c =>
        `<label data-name="${esc(colTitle(c).toLowerCase())}"><input type="checkbox" data-ck="${esc(c.key)}" ${isVisible(c, v, all.length) ? 'checked' : ''}> ${esc(c.name)} <span class="muted">(${c.distinct})</span></label>`).join('')).join('')}`;
    const rc = btn.getBoundingClientRect();
    popup.style.left = Math.min(rc.left, innerWidth - 300) + 'px';
    popup.style.top = rc.bottom + 4 + 'px';
    popup.hidden = false;
    $('#cpFilter', popup).focus();
  }
  popup.addEventListener('change', e => {
    const k = e.target.dataset.ck; if (k === undefined) return;
    view(state.cache.ds.id).colVis[k] = e.target.checked;
    renderTable(state.cache.ds);
  });
  popup.addEventListener('input', e => {
    if (e.target.id !== 'cpFilter') return;
    const q = e.target.value.toLowerCase();
    popup.querySelectorAll('label[data-name]').forEach(l => (l.hidden = !l.dataset.name.includes(q)));
  });
  popup.addEventListener('click', e => {
    const a = e.target.dataset.cp; if (!a) return;
    const { cols, ds } = state.cache, v = view(ds.id);
    if (a === 'reset') v.colVis = {};
    else cols.forEach(c => (v.colVis[c.key] = a === 'all' || c.virtual || LABEL_KEYS.includes(c.name)));
    renderTable(ds);
    openColPicker($('#colBtn'));
  });
  document.addEventListener('mousedown', e => {
    if (!popup.hidden && !popup.contains(e.target) && e.target.id !== 'colBtn') popup.hidden = true;
  });

  // ---------- events ----------
  function navigate(id, preset) {
    state.current = id;
    state.selected.clear(); state.lastSel = -1; state.cellSel = null;
    if (id !== '__overview') view(id).preset = preset || null;
    popup.hidden = true;
    refresh();
  }
  sidebar.addEventListener('click', e => {
    const a = e.target.closest('[data-nav]'); if (!a) return;
    navigate(a.dataset.nav, a.dataset.pk ? { key: a.dataset.pk, value: a.dataset.pv } : null);
  });

  main.addEventListener('click', e => {
    const t = e.target;
    if (!state.data) return;
    const card = t.closest('.card[data-nav]');
    if (card) return navigate(card.dataset.nav);
    const navLink = t.closest('[data-nav-link]');
    if (navLink) { e.preventDefault(); return navigate(navLink.dataset.navLink); }
    if (t.dataset.create) return openCreate(t.dataset.create);
    if (t.id === 'rawAll') return openDrawer('Whole file', state.data, p => { if (!isObj(p) && !Array.isArray(p)) throw new Error('Must be an object or array'); state.data = p; });
    if (t.dataset.rawsec) { const k = t.dataset.rawsec; return openDrawer(k, state.data[k], p => { state.data[k] = p; }); }
    if (state.current === '__overview' || !state.cache) return;

    const { ds } = state.cache, v = view(ds.id);
    switch (t.id) {
      case 'clearPreset': case '': break;
      case 'colBtn': return popup.hidden ? openColPicker(t) : (popup.hidden = true);
      case 'clearFilters': v.filters = {}; v.search = ''; v.preset = null; return refresh();
      case 'rawDs': return openDrawer(ds.id, ds.getArr(), p => { if (!Array.isArray(p)) throw new Error('Must be a JSON array'); const arr = ds.getArr(); arr.splice(0, arr.length, ...p); });
      case 'bulkBtn': return openBulk();
      case 'resetOvBtn': return selectedVisible().length ? resetOverrides(selectedVisible()) : toast('Select rows first');
      case 'typeBtn': return openTypeDlg();
      case 'dupBtn': return duplicateRows(selectedVisible());
      case 'delBtn': return deleteRows(selectedVisible());
      case 'selNone': state.selected.clear(); return renderBody();
      case 'selAll': {
        const on = t.checked;
        state.vis.forEach(r => (on ? state.selected.add(selKey(r)) : state.selected.delete(selKey(r))));
        return renderBody();
      }
    }
    if (t.closest('#clearPreset')) { v.preset = null; return refresh(); }

    if (t.dataset.colbulk !== undefined) {
      const j = +t.dataset.colbulk, R = selRange();
      // A cell range in this column takes priority, then checked rows, then all filtered rows.
      if (R && j >= R.c0 && j <= R.c1 && R.p1 > R.p0) {
        const rows = state.shown.slice(R.p0, R.p1 + 1).map(i => state.vis[i]);
        return openBulk(state.cache.visCols[j].key, { rows, label: `<strong>${rows.length}</strong> selected cell(s) in this column` });
      }
      return openBulk(state.cache.visCols[j].key);
    }
    if (t.dataset.colsel !== undefined) {
      const c = +t.dataset.colsel;
      document.activeElement?.blur?.();
      return selectColumns(e.shiftKey && state.cellSel ? state.cellSel.a.c : c, c);
    }
    const sortTh = t.closest('th[data-sort]');
    if (sortTh) {
      const k = sortTh.dataset.sort, s = v.sort;
      v.sort = !s || s.key !== k ? { key: k, dir: 1 } : s.dir === 1 ? { key: k, dir: -1 } : null;
      return renderTable(ds);
    }

    const gr = t.closest('tr.grouprow');
    if (gr) {
      const g = gr.dataset.g;
      const idx = state.vis.map((r, i) => i).filter(i => display(valByKey(v.groupBy, state.vis[i])) === g);
      if (t.dataset.gsel !== undefined) idx.forEach(i => (t.checked ? state.selected.add(selKey(state.vis[i])) : state.selected.delete(selKey(state.vis[i]))));
      else v.collapsed.has(g) ? v.collapsed.delete(g) : v.collapsed.add(g);
      return renderBody();
    }

    const tr = t.closest('tr[data-r]'); if (!tr) return;
    const i = +tr.dataset.r, r = state.vis[i];

    if (t.dataset.sel !== undefined) {
      const pos = state.order.indexOf(i);
      if (e.shiftKey && state.lastSel >= 0) {
        const lp = state.order.indexOf(state.lastSel), on = t.checked;
        for (let p = Math.min(pos, lp); p <= Math.max(pos, lp); p++) {
          const o = selKey(state.vis[state.order[p]]);
          on ? state.selected.add(o) : state.selected.delete(o);
        }
      } else t.checked ? state.selected.add(selKey(r)) : state.selected.delete(selKey(r));
      state.lastSel = i;
      return renderBody();
    }
    const act = t.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'members') return navigate('Instances › Members', { key: '__parent', value: labelOf(r.obj) });
      if (act.dataset.act === 'ovjson') return openOverrideJson(r);
      if (act.dataset.act === 'reset') return resetOverrides([r]);
      if (act.dataset.act === 'json') return openRowJson(r);
      if (act.dataset.act === 'dup') return duplicateRows([r]);
      if (act.dataset.act === 'del') return deleteRows([r]);
    }
    const td = t.closest('td[data-c]'); if (!td) return;
    const c = state.cache.visCols[+td.dataset.c];
    if (ds.instanceView && t.dataset.arr !== undefined) return openOverrideJson(r);
    if (t.dataset.bool !== undefined) {
      e.preventDefault();
      if (e.shiftKey) return;
      return setCells([r], c, (_, cur) => (isStrBool(cur) ? (cur === 'True' ? 'False' : 'True') : !cur));
    }
    if (t.dataset.arr !== undefined) {
      const child = state.ds.find(d => d.isNested && d.parentId === ds.id && c.path.length === 1 && d.nestedKey === c.path[0]);
      return child ? navigate(child.id, { key: '__parent', value: labelOf(r.obj) }) : openRowJson(r);
    }
  });

  main.addEventListener('dblclick', e => {
    const td = e.target.closest('td.cell');
    if (td && !e.target.closest('input')) startEdit(td);
  });

  main.addEventListener('input', e => {
    if (!state.cache) return;
    const t = e.target, v = view(state.cache.ds.id);
    if (t.id === 'search') { v.search = t.value; renderBody(); }
    else if (t.dataset.filter !== undefined) { v.filters[t.dataset.filter] = t.value; renderBody(); }
  });

  main.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.root !== undefined) {
      const k = t.dataset.root, cur = state.data[k];
      try { mutate(() => { state.data[k] = typeof cur === 'boolean' ? t.checked : coerce(t.value, cur === null ? 'string' : typeof cur); }, `Updated ${k}`); }
      catch (err) { toast(err.message, 4000); renderOverview(); }
      return;
    }
    if (!state.cache) return;
    const v = view(state.cache.ds.id);
    if (t.id === 'groupBy') { v.groupBy = t.value; v.collapsed.clear(); renderBody(); }
    else if (t.id === 'hideUni') { v.hideUniform = t.checked; renderTable(state.cache.ds); }
  });

  $('#fileInput').addEventListener('change', e => { readFile(e.target.files[0]); e.target.value = ''; });
  $('#saveBtn').onclick = saveJson;
  $('#csvBtn').onclick = exportCsv;
  $('#undoBtn').onclick = () => undoRedo(state.undo, state.redo);
  $('#redoBtn').onclick = () => undoRedo(state.redo, state.undo);
  $('#drawerClose').onclick = () => (drawer.hidden = true);
  $('#drawerApply').onclick = () => {
    let p;
    try { p = JSON.parse($('#drawerText').value); } catch (e) { $('#drawerErr').textContent = 'Invalid JSON: ' + e.message; return; }
    try { mutate(() => state.drawerApply(p), 'JSON applied'); drawer.hidden = true; }
    catch (e) { $('#drawerErr').textContent = e.message; }
  };

  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); saveJson(); return; }
    if (e.target.closest('input, textarea') || dlg.open) return;
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoRedo(state.undo, state.redo); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); undoRedo(state.redo, state.undo); }
  });

  document.addEventListener('dragover', e => { e.preventDefault(); $('.dropzone')?.classList.add('over'); });
  document.addEventListener('dragleave', () => $('.dropzone')?.classList.remove('over'));
  document.addEventListener('drop', e => { e.preventDefault(); readFile(e.dataTransfer.files[0]); });
  window.addEventListener('beforeunload', e => { if (state.dirty) e.preventDefault(); });
})();
