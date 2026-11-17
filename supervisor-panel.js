/**
 * Supervisor-Panel für Home Assistant
 * Ersetzt das in HA 2026.5 entfernte Supervisor-Sidebar-Panel
 *
 * https://github.com/Pjarbit/supervisor-panel
 *
 * @version 1.2.0
 * @author Pjarbit
 *
 * @version 1.2.1
 * @author chrischan
 *
 * 1.2.1: Basis Pjarbit 1.2.0 (HA-Farben), Menü-Button für die Seitenleiste,
 *        Live-Werte über hass statt get_states, echte Core-/Supervisor-Werte,
 *        Rechnerwerte in der Host-Karte, Protokoll-Abruf pausiert im Hintergrund
 *
 * @license MIT
 */

const SUPERVISOR_PANEL_VERSION = '1.2.1';

/** Feste Entitäten dieser Installation (für andere Systeme gibt es einen Stichwort-Fallback) */
const SP_ENTITIES = {
  coreUpdate: 'update.home_assistant_core_update',
  supUpdate: 'update.home_assistant_supervisor_update',
  osUpdate: 'update.home_assistant_operating_system_update',
  coreCpu: 'sensor.home_assistant_core_cpu_percent',
  coreRam: 'sensor.home_assistant_core_memory_percent',
  supCpu: 'sensor.home_assistant_supervisor_cpu_percent',
  supRam: 'sensor.home_assistant_supervisor_memory_percent',
  hostCpu: 'sensor.system_monitor_prozessornutzung',
  hostLoad: 'sensor.system_monitor_last_1_min',
  hostTemp: 'sensor.system_monitor_prozessortemperatur',
  ramPct: 'sensor.system_monitor_arbeitsspeicherauslastung',
  ramUse: 'sensor.system_monitor_belegter_arbeitsspeicher',
  ramFree: 'sensor.system_monitor_freier_arbeitsspeicher',
  diskPct: 'sensor.system_monitor_massenspeicher_auslastung',
  diskUse: 'sensor.system_monitor_belegter_massenspeicher',
  diskFree: 'sensor.system_monitor_freier_massenspeicher',
  lastBoot: 'sensor.system_monitor_letzter_systemstart',
};

class SupervisorPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._narrow = false;
    this._rendered = false;
    this._logPaused = false;
    this._rawLines = [];
    this._logGen = 0;
    this._ids = null;
    this._lastStates = {};
    this._renderQueued = false;
    this._onVisibility = () => {
      if (!document.hidden && !this._logPaused) this._loadLogs();
    };
  }

  /** Wird von Home Assistant bei jeder Zustandsänderung gesetzt */
  set hass(hass) {
    this._hass = hass;
    this._syncMenuButton();
    if (this._rendered) this._queueCards();
  }
  get hass() { return this._hass; }

  /** Wird von Home Assistant gesetzt: true in der schmalen Ansicht (Handy) */
  set narrow(narrow) {
    this._narrow = !!narrow;
    this._syncMenuButton();
  }
  get narrow() { return this._narrow; }

  connectedCallback() {
    if (!this._rendered) {
      this.style.cssText = 'display:block;height:100%;overflow:auto;background:var(--primary-background-color,#111)';
      this.render();
      this._rendered = true;
    }
    this._syncMenuButton();
    this._renderCards(true);
    this._loadLogs();

    clearInterval(this._logInterval);
    clearInterval(this._clockInterval);
    this._logInterval = setInterval(() => {
      if (!this._logPaused && !document.hidden) this._loadLogs();
    }, 10000);
    // Hält die relative Angabe "vor X Min." aktuell und prüft die Entitäten neu
    this._clockInterval = setInterval(() => this._renderCards(true), 60000);
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  disconnectedCallback() {
    clearInterval(this._logInterval);
    clearInterval(this._clockInterval);
    document.removeEventListener('visibilitychange', this._onVisibility);
  }

  /** Menü-Button für die Seitenleiste: nutzt den HA-eigenen Button, sonst einen einfachen Ersatz */
  _syncMenuButton() {
    const slot = this.querySelector('#menu-slot');
    if (!slot) return;

    if (this._hass && customElements.get('ha-menu-button')) {
      let btn = slot.querySelector('ha-menu-button');
      if (!btn) {
        btn = document.createElement('ha-menu-button');
        btn.hass = this._hass;
        btn.narrow = this._narrow;
        slot.replaceChildren(btn);
      } else {
        btn.hass = this._hass;
        btn.narrow = this._narrow;
      }
      // Der HA-Button blendet sich in der breiten Ansicht selbst aus
      slot.style.display = '';
      return;
    }

    let fb = slot.querySelector('.menu-fallback');
    if (!fb) {
      fb = document.createElement('button');
      fb.type = 'button';
      fb.className = 'menu-fallback';
      fb.title = 'Seitenleiste öffnen';
      fb.setAttribute('aria-label', 'Seitenleiste öffnen');
      fb.textContent = '☰';
      fb.onclick = () => this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true }));
      slot.replaceChildren(fb);
      if (!customElements.get('ha-menu-button')) {
        customElements.whenDefined('ha-menu-button').then(() => this._syncMenuButton());
      }
    }
    const show = this._narrow || this._hass?.dockedSidebar === 'always_hidden';
    slot.style.display = show ? '' : 'none';
  }

  /** Holt ein gültiges Zugriffstoken (erneuert es bei Bedarf) */
  async _getToken() {
    let auth = this._hass?.auth;
    if (!auth && typeof hassConnection !== 'undefined') auth = (await hassConnection).auth;
    if (!auth) throw new Error('Keine Anmeldung verfügbar – Seite neu laden.');
    if (auth.expired && typeof auth.refreshAccessToken === 'function') {
      await auth.refreshAccessToken();
    }
    return auth.accessToken || auth.data?.access_token;
  }

  /** Ruft Logs von der Supervisor-REST-API ab */
  async _apiLogs(endpoint) {
    const token = await this._getToken();
    let r;
    try {
      r = await fetch(`/api/hassio/${endpoint}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (networkErr) {
      throw new Error(`Netzwerkfehler beim Abruf von "${endpoint}" – Verbindung zu Home Assistant unterbrochen.`);
    }
    if (!r.ok) throw new Error(this._apiErrorMessage(r.status, endpoint));
    return r.text();
  }

  /** Sendet einen POST-Request an die Supervisor-REST-API (z.B. für supervisor/restart) */
  async _apiPost(endpoint) {
    const token = await this._getToken();
    let r;
    try {
      r = await fetch(`/api/hassio/${endpoint}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (networkErr) {
      throw new Error(`Netzwerkfehler beim Aufruf von "${endpoint}" – Verbindung zu Home Assistant unterbrochen.`);
    }
    if (!r.ok) throw new Error(this._apiErrorMessage(r.status, endpoint));
    return true;
  }

  /** Übersetzt einen HTTP-Statuscode der Hassio-API in eine verständliche Fehlermeldung */
  _apiErrorMessage(status, endpoint) {
    switch (status) {
      case 401:
      case 403:
        return `Zugriff verweigert (HTTP ${status}) – Token abgelaufen oder keine Berechtigung. Seite neu laden und erneut versuchen.`;
      case 404:
        return `Endpunkt nicht gefunden (HTTP 404) – "${endpoint}" existiert nicht. Läuft der Supervisor auf diesem Host?`;
      case 502:
      case 503:
      case 504:
        return `Supervisor nicht erreichbar (HTTP ${status}) – möglicherweise startet er gerade neu.`;
      default:
        return `Unerwarteter Fehler (HTTP ${status}) beim Abruf von "${endpoint}".`;
    }
  }

  render() {
    this.innerHTML = `
      <style>
        .page { padding:16px; max-width:1200px; margin:0 auto; font-family:var(--paper-font-body1_-_font-family,Roboto,sans-serif); }
        h1 { color:var(--primary-text-color,#fff); font-size:1.4em; margin:0 0 4px; display:flex; align-items:center; flex-wrap:wrap; }
        h1 .title { margin-right:12px; }
        #menu-slot { display:inline-flex; align-items:center; color:var(--primary-text-color,#fff); }
        .updated { font-size:0.75em; color:var(--secondary-text-color,#aaa); }
        .toolbar { display:flex; gap:8px; margin:8px 0 16px; }
        .cards { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:16px; }
        @media(max-width:800px) { .cards { grid-template-columns:1fr; } }
        .card { background:var(--card-background-color,#1c1c1c); border-radius:12px; padding:16px; box-shadow: 12px 12px 24px rgba(0,0,0,0.5), inset -4px -4px 8px rgba(0,0,0,0.2), inset 4px 4px 8px rgba(255,255,255,0.2); display:flex; flex-direction:column; }
        .card h2 { margin:0 0 12px; font-size:1.1em; color:var(--primary-text-color,#fff); }
        .card-body { flex:1; }
        .subhead { margin:12px 0 8px; font-size:1.1em; color:var(--primary-text-color,#fff); font-weight:500; }
        .row { display:flex; justify-content:space-between; margin-bottom:8px; font-size:0.85em; }
        .label { color:var(--secondary-text-color,#aaa); }
        .value { color:var(--primary-text-color,#fff); font-weight:500; }
        .value.warning { color:#ff9800; }
        .bar-wrap { background:rgba(255,255,255,0.1); border-radius:4px; height:6px; margin-top:4px; margin-bottom:10px; overflow:hidden; }
        .bar { height:100%; border-radius:4px; transition:width 0.4s; }
        .bar.low { background:#4caf50; }
        .bar.mid { background:#ff9800; }
        .bar.high { background:#f44336; }
        .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.07); align-items:center; }
        .panel-version-tag { font-size:0.65em; color:var(--secondary-text-color,#888); margin-left:auto; letter-spacing:0.05em; }
        button {
          background:transparent;
          border:1px solid #03a9f4;
          color:#03a9f4;
          padding:6px 14px;
          border-radius:4px;
          cursor:pointer;
          font-size:0.8em;
          text-transform:uppercase;
          letter-spacing:0.05em;
          transition:all 0.2s;
        }
        button:hover { background:rgba(3,169,244,0.15); }
        button:disabled { opacity:0.4; cursor:default; }
        button.menu-fallback { border:none; color:var(--primary-text-color,#fff); font-size:1.2em; padding:4px 12px 4px 0; text-transform:none; letter-spacing:0; }
        button.menu-fallback:hover { background:transparent; }
        button.neutral { border-color:#cccccc; color:#cccccc; }
        button.neutral:hover { background:rgba(204,204,204,0.15); }
        button.teal {
          background:#03a9f4;
          border-color:#03a9f4;
          color:rgba(255,255,255,1.0);
          box-shadow: 6px 6px 12px rgba(0,0,0,0.5), -2px -2px 6px rgba(255,255,255,0.1);
        }
        button.teal:hover { background:#0290d0; box-shadow: 4px 4px 8px rgba(0,0,0,0.5), -1px -1px 4px rgba(255,255,255,0.1); }
        button.orange {
          background:#db4437;
          border-color:#db4437;
          color:rgba(255,255,255,1.0);
          box-shadow: 6px 6px 12px rgba(0,0,0,0.5), -2px -2px 6px rgba(255,255,255,0.1);
        }
        button.orange:hover { background:#c23328; box-shadow: 4px 4px 8px rgba(0,0,0,0.5), -1px -1px 4px rgba(255,255,255,0.1); }
        .update-badge { font-size:0.75em; background:#ff9800; color:#000; padding:2px 8px; border-radius:10px; margin-left:8px; }
        .log-card { background:var(--card-background-color,#1c1c1c); border-radius:12px; padding:16px; box-shadow: 12px 12px 24px rgba(0,0,0,0.5), inset -4px -4px 8px rgba(0,0,0,0.2), inset 4px 4px 8px rgba(255,255,255,0.2); }
        .log-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px; }
        .log-header h2 { margin:0; font-size:1.1em; color:var(--primary-text-color,#fff); }
        .log-controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
        select.log-select, input.log-search {
          background:var(--card-background-color,#1c1c1c);
          color:var(--primary-text-color,#fff);
          border:1px solid rgba(255,255,255,0.2);
          border-radius:4px;
          padding:4px 8px;
          font-size:0.85em;
        }
        input.log-search { width:180px; }
        pre {
          margin:0; font-size:0.75em; line-height:1.5; color:#ccc;
          background:#0a0a0a; border-radius:8px; padding:12px;
          overflow-x:auto; max-height:420px; overflow-y:auto;
          white-space:pre-wrap; word-break:break-all;
        }
        .log-line.error { color:#f44336; }
        .log-line.warning { color:#ff9800; }
        .log-line.info { color:#ccc; }
        .log-line.highlight { background:rgba(255,235,59,0.2); }
        .toast {
          position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
          background:#323232; color:#fff; padding:10px 20px; border-radius:6px;
          font-size:0.85em; z-index:9999; opacity:0; transition:opacity 0.3s;
          pointer-events:none;
        }
        .toast.show { opacity:1; }
        .spinner {
          display:inline-block; width:12px; height:12px;
          border:2px solid rgba(255,255,255,0.2); border-top-color:#fff;
          border-radius:50%; animation:spin 0.6s linear infinite; margin-right:6px;
        }
        @keyframes spin { to { transform:rotate(360deg); } }
        .modal-overlay {
          display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6);
          z-index:10000; align-items:center; justify-content:center;
        }
        .modal-overlay.show { display:flex; }
        .modal-dialog {
          background:var(--card-background-color,#1c1c1c); border-radius:12px;
          padding:24px; max-width:360px; width:90%;
          box-shadow: 12px 12px 24px rgba(0,0,0,0.5), -4px -4px 8px rgba(255,255,255,0.1);
        }
        .modal-dialog h3 { margin:0 0 12px; color:var(--primary-text-color,#fff); font-size:1.1em; }
        .modal-dialog p { margin:0 0 20px; color:var(--secondary-text-color,#ccc); font-size:0.9em; line-height:1.4; }
        .modal-actions { display:flex; justify-content:flex-end; gap:8px; }
      </style>
      <div class="page">
        <h1><span id="menu-slot"></span><span class="title">Supervisor</span><span class="updated" id="last-updated"></span></h1>
        <div class="toolbar">
          <button id="btn-refresh" class="teal">↻ Alles aktualisieren</button>
        </div>
        <div class="cards">
          <div class="card">
            <h2>Core</h2>
            <div class="card-body" id="core-info"><span class="spinner"></span> Wird geladen...</div>
            <div class="actions">
              <button id="btn-restart-core" class="teal">Core neu starten</button>
            </div>
          </div>
          <div class="card">
            <h2>Supervisor</h2>
            <div class="card-body" id="supervisor-info"><span class="spinner"></span> Wird geladen...</div>
            <div class="actions">
              <button id="btn-restart-supervisor" class="teal">Supervisor neu starten</button>
            </div>
          </div>
          <div class="card">
            <h2>Host</h2>
            <div class="card-body" id="host-info"><span class="spinner"></span> Wird geladen...</div>
            <div class="actions">
              <button id="btn-reboot-host" class="teal">Host neu starten</button>
              <button id="btn-shutdown-host" class="orange">Host herunterfahren</button>
              <span class="panel-version-tag">chrischan | v<span id="panel-version"></span></span>
            </div>
          </div>
        </div>
        <div class="log-card">
          <div class="log-header">
            <h2>Protokolle</h2>
            <div class="log-controls">
              <input class="log-search" id="log-search" placeholder="Protokolle filtern..." maxlength="100" />
              <select class="log-select" id="log-source">
                <option value="core">Core</option>
                <option value="supervisor" selected>Supervisor</option>
                <option value="host">Host</option>
              </select>
              <button id="btn-pause" class="neutral">⏸ Pause</button>
              <button id="btn-bottom" class="neutral">↓ Nach unten</button>
            </div>
          </div>
          <pre id="log-output"><span class="spinner"></span> Protokolle werden geladen...</pre>
        </div>
      </div>
      <div class="toast" id="toast"></div>
      <div class="modal-overlay" id="modal-overlay">
        <div class="modal-dialog">
          <h3 id="modal-title"></h3>
          <p id="modal-message"></p>
          <div class="modal-actions">
            <button id="modal-cancel" class="neutral">Abbrechen</button>
            <button id="modal-confirm" class="orange">Bestätigen</button>
          </div>
        </div>
      </div>
    `;

    const vEl = this.querySelector('#panel-version');
    if (vEl) vEl.textContent = SUPERVISOR_PANEL_VERSION;
    this.querySelector('#btn-refresh').onclick = () => {
      this._renderCards(true);
      this._loadLogs();
    };
    this.querySelector('#btn-restart-core').onclick = () => this._serviceAction('homeassistant', 'restart', 'Core neu starten');
    this.querySelector('#btn-restart-supervisor').onclick = () => this._apiAction('supervisor/restart', 'Supervisor neu starten');
    this.querySelector('#btn-reboot-host').onclick = () => this._serviceAction('hassio', 'host_reboot', 'Host neu starten');
    this.querySelector('#btn-shutdown-host').onclick = () => this._serviceAction('hassio', 'host_shutdown', 'Host herunterfahren');
    this.querySelector('#log-source').onchange = () => this._loadLogs();
    this.querySelector('#log-search').oninput = () => this._filterLogs();
    this.querySelector('#btn-bottom').onclick = () => {
      const pre = this.querySelector('#log-output');
      if (pre) pre.scrollTop = pre.scrollHeight;
    };
    this.querySelector('#btn-pause').onclick = (e) => {
      this._logPaused = !this._logPaused;
      e.target.textContent = this._logPaused ? '▶ Fortsetzen' : '⏸ Pause';
    };
  }

  /** Gibt einen farbcodierten Fortschrittsbalken (HTML-String) basierend auf Prozentwert zurück */
  _bar(pct) {
    const p = Math.min(100, Math.max(0, parseFloat(pct) || 0));
    const cls = p < 50 ? 'low' : p < 80 ? 'mid' : 'high';
    return `<div class="bar-wrap"><div class="bar ${cls}" style="width:${p}%"></div></div>`;
  }

  /** Gibt eine Label/Wert-Zeile (HTML-String) zurück */
  _row(label, value, cssClass = '') {
    return `<div class="row"><span class="label">${label}</span><span class="value${cssClass ? ' ' + cssClass : ''}">${value}</span></div>`;
  }

  /** Zahlenwert einer Entität oder null (bei fehlend, unknown, unavailable) */
  _num(id) {
    const s = id && this._hass?.states[id];
    if (!s) return null;
    const v = parseFloat(s.state);
    return isNaN(v) ? null : v;
  }

  /** Prozent-Zeile samt Balken; bei fehlendem Wert nur "—" */
  _pctRow(label, value) {
    if (value === null || value === undefined) return this._row(label, '—');
    return this._row(label, value.toFixed(1) + '%') + this._bar(value);
  }

  /** Formatiert den letzten Boot-Zeitstempel in ein lesbares Datum plus relative Laufzeit */
  _formatLastBoot(state) {
    if (!state || state === 'unknown' || state === 'unavailable') return '—';

    const d = new Date(state);
    if (isNaN(d.getTime())) return state;

    const dateStr = d.toLocaleString(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const diffMs = Date.now() - d.getTime();
    if (diffMs < 0) return dateStr;

    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);

    let relative = '';
    if (days > 0) {
      relative = `vor ${days} Tag${days > 1 ? 'en' : ''}`;
    } else if (hours > 0) {
      relative = `vor ${hours} Std.`;
    } else {
      relative = `vor ${Math.max(1, mins)} Min.`;
    }

    return `${dateStr} <span style="font-size:0.85em;opacity:0.8;">(${relative})</span>`;
  }

  /** Gibt Versions-HTML mit optionalem Update-Badge zurück */
  _versionHtml(entity) {
    if (!entity) return '—';
    const installed = entity.attributes.installed_version || '—';
    const latest = entity.attributes.latest_version;
    if (entity.state === 'on' && latest) {
      return `${installed} <span class="update-badge">↑ ${latest}</span>`;
    }
    return installed;
  }

  /** Rechnet einen Speicherwert samt Einheit in GiB um und gibt ihn formatiert zurück */
  _toGiB(value, unit) {
    if (value === undefined || value === null || isNaN(value)) return null;
    const v = parseFloat(value);
    const factor = (unit === 'MiB' || unit === 'MB') ? 1 / 1024 : 1;
    return (v * factor).toFixed(3) + ' GiB';
  }

  /** Ermittelt die Entity-IDs: zuerst feste ID, sonst Stichwort-Suche */
  _resolveIds(states) {
    const all = Object.values(states);
    const pick = (fixed, keywords, units) => {
      if (states[fixed]) return fixed;
      if (!keywords) return null;
      const hit = all.find(s =>
        s.entity_id.startsWith('sensor.') &&
        keywords.some(k => s.entity_id.includes(k)) &&
        (!units || units.includes(s.attributes?.unit_of_measurement)));
      return hit ? hit.entity_id : null;
    };
    const E = SP_ENTITIES;
    const ids = {
      coreUpdate: pick(E.coreUpdate),
      supUpdate: pick(E.supUpdate),
      osUpdate: pick(E.osUpdate),
      coreCpu: pick(E.coreCpu),
      coreRam: pick(E.coreRam),
      supCpu: pick(E.supCpu),
      supRam: pick(E.supRam),
      hostCpu: pick(E.hostCpu, ['processor_use', 'cpu_use', 'processor_usage', 'cpu_usage', 'prozessornutzung', 'prozessorauslastung'], ['%']),
      hostTemp: pick(E.hostTemp, ['processor_temperature', 'cpu_temperature', 'prozessortemperatur'], ['°C', '°F']),
      ramPct: pick(E.ramPct, ['memory_usage', 'memory_use_percent', 'virtual_memory', 'arbeitsspeicherauslastung'], ['%']),
      ramUse: pick(E.ramUse, ['memory_use', 'belegter_arbeitsspeicher'], ['MiB', 'MB', 'GB', 'GiB']),
      ramFree: pick(E.ramFree, ['memory_free', 'freier_arbeitsspeicher'], ['MiB', 'MB', 'GB', 'GiB']),
      diskPct: pick(E.diskPct, ['disk_usage', 'disk_use_percent', 'massenspeicher_auslastung'], ['%']),
      diskUse: pick(E.diskUse, ['disk_use', 'belegter_massenspeicher'], ['GiB', 'GB']),
      diskFree: pick(E.diskFree, ['disk_free', 'freier_massenspeicher'], ['GiB', 'GB']),
      lastBoot: pick(E.lastBoot, ['last_boot', 'last_boot_time', 'uptime', 'letzter_systemstart', 'systemstart']),
    };
    // Ohne CPU-Prozent: Last (1 min) als Ersatz
    ids.hostLoad = ids.hostCpu ? null : pick(E.hostLoad, ['load_1_min', 'load_1m', 'processor_load', 'load1', 'last_1_min']);
    return ids;
  }

  /** Bündelt schnelle hass-Updates zu einem Neuzeichnen pro Frame */
  _queueCards() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._renderCards(false);
    });
  }

  /** Zeichnet die drei Karten aus hass.states; ohne force nur, wenn sich eine genutzte Entität geändert hat */
  _renderCards(force) {
    const hass = this._hass;
    if (!hass || !this._rendered) return;
    const states = hass.states;

    if (force || !this._ids) this._ids = this._resolveIds(states);
    const ids = this._ids;
    const used = Object.values(ids).filter(Boolean);

    if (!force && !used.some(id => states[id] !== this._lastStates[id])) return;
    this._lastStates = {};
    used.forEach(id => { this._lastStates[id] = states[id]; });

    try {
      // --- Core-Karte: Werte des Core-Prozesses ---
      this.querySelector('#core-info').innerHTML =
        this._row('Version', this._versionHtml(states[ids.coreUpdate])) +
        this._pctRow('CPU', this._num(ids.coreCpu)) +
        this._pctRow('RAM', this._num(ids.coreRam));

      // --- Supervisor-Karte ---
      const supUpdate = states[ids.supUpdate];
      const osUpdate = states[ids.osUpdate];
      const supUpdateAvailable = supUpdate?.state === 'on';
      const osUpdateAvailable = osUpdate?.state === 'on';

      this.querySelector('#supervisor-info').innerHTML =
        this._row('Version', this._versionHtml(supUpdate)) +
        this._row('Supervisor Update verfügbar', supUpdateAvailable ? 'Ja' : 'Nein', supUpdateAvailable ? 'warning' : '') +
        this._pctRow('CPU', this._num(ids.supCpu)) +
        this._pctRow('RAM', this._num(ids.supRam)) +
        '<div class="subhead">HA OS</div>' +
        this._row('OS Version', this._versionHtml(osUpdate)) +
        this._row('OS Update verfügbar', osUpdateAvailable ? 'Ja' : 'Nein', osUpdateAvailable ? 'warning' : '');

      // --- Host-Karte: Werte des ganzen Rechners (System Monitor) ---
      let hostCpu = this._num(ids.hostCpu);
      if (hostCpu === null && ids.hostLoad) {
        const load = this._num(ids.hostLoad);
        const cores = navigator.hardwareConcurrency || 4;
        hostCpu = load === null ? null : Math.min(100, load / cores * 100);
      }
      const temp = states[ids.hostTemp];
      const tempNum = this._num(ids.hostTemp);
      const ramUse = states[ids.ramUse];
      const ramFree = states[ids.ramFree];
      const diskUse = this._num(ids.diskUse);
      const diskFree = this._num(ids.diskFree);

      this.querySelector('#host-info').innerHTML =
        this._row('Letzter Start', this._formatLastBoot(states[ids.lastBoot]?.state)) +
        this._pctRow('CPU Last', hostCpu) +
        (tempNum !== null ? this._row('CPU Temperatur', tempNum.toFixed(1) + ' ' + (temp.attributes?.unit_of_measurement || '°C')) : '') +
        this._pctRow('RAM Auslastung', this._num(ids.ramPct)) +
        this._row('RAM belegt', this._num(ids.ramUse) !== null ? this._toGiB(ramUse.state, ramUse.attributes?.unit_of_measurement) : '—') +
        this._row('RAM frei', this._num(ids.ramFree) !== null ? this._toGiB(ramFree.state, ramFree.attributes?.unit_of_measurement) : '—') +
        this._pctRow('Speicherplatz Auslastung', this._num(ids.diskPct)) +
        this._row('Speicherplatz belegt', diskUse !== null ? diskUse.toFixed(1) + ' GB' : '—') +
        this._row('Speicherplatz frei', diskFree !== null ? diskFree.toFixed(1) + ' GB' : '—');

      this.querySelector('#last-updated').textContent = `Aktualisiert ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      console.error('[SupervisorPanel] Fehler beim Zeichnen:', e);
      this._showError(e.message);
    }
  }

  async _loadLogs() {
    const gen = ++this._logGen;
    const srcEl = this.querySelector('#log-source');
    if (!srcEl) return;
    const src = srcEl.value;
    const endpoint = src === 'core' ? 'core/logs' : src === 'host' ? 'host/logs' : 'supervisor/logs';
    const pre = this.querySelector('#log-output');
    if (!pre) return;
    try {
      const text = await this._apiLogs(endpoint);
      if (gen !== this._logGen) return; // veralteter Aufruf – neuere Log-Anfrage läuft bereits
      const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-n=><]/g;

      this._rawLines = text.trim().split('\n')
        .slice(-200)
        .map(l => l.replace(ansiRegex, ''));
      this._filterLogs();
    } catch (e) {
      if (gen !== this._logGen) return;
      pre.textContent = `Protokolle konnten nicht geladen werden: ${e.message}`;
    }
  }

  _filterLogs() {
    const pre = this.querySelector('#log-output');
    if (!pre) return;
    const raw = this.querySelector('#log-search')?.value || '';
    const search = raw.toLowerCase().trim().slice(0, 100);
    const filtered = search
      ? this._rawLines.filter(l => l.toLowerCase().includes(search))
      : this._rawLines;
    pre.innerHTML = filtered.map(l => {
      const cls = /error|critical/i.test(l) ? 'error'
                : /warning|warn/i.test(l) ? 'warning' : 'info';
      const hl = search && l.toLowerCase().includes(search) ? ' highlight' : '';
      return `<span class="log-line ${cls}${hl}">${this._esc(l)}</span>`;
    }).join('\n');
    if (!search) pre.scrollTop = pre.scrollHeight;
  }

  _esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** Zeigt den eigenen Bestätigungsdialog und löst mit true/false auf, statt window.confirm zu blockieren */
  _confirm(title, message) {
    return new Promise(resolve => {
      const overlay = this.querySelector('#modal-overlay');
      const titleEl = this.querySelector('#modal-title');
      const msgEl = this.querySelector('#modal-message');
      const btnConfirm = this.querySelector('#modal-confirm');
      const btnCancel = this.querySelector('#modal-cancel');
      if (!overlay || !titleEl || !msgEl || !btnConfirm || !btnCancel) {
        resolve(false);
        return;
      }
      titleEl.textContent = title;
      msgEl.textContent = message;
      overlay.classList.add('show');

      const cleanup = (result) => {
        overlay.classList.remove('show');
        btnConfirm.onclick = null;
        btnCancel.onclick = null;
        overlay.onclick = null;
        resolve(result);
      };

      btnConfirm.onclick = () => cleanup(true);
      btnCancel.onclick = () => cleanup(false);
      overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    });
  }

  /** Ruft eine HA-Aktion nach Bestätigung auf */
  async _serviceAction(domain, service, label) {
    const ok = await this._confirm(label, 'Dies wirkt sich auf deine Home Assistant-Instanz aus.');
    if (!ok) return;
    this._toast(`${label}...`);
    try {
      if (this._hass) {
        await this._hass.callService(domain, service);
      } else {
        const c = await hassConnection;
        await c.conn.sendMessagePromise({ type: 'call_service', domain, service });
      }
      this._toast(`${label} eingeleitet.`);
    } catch (e) {
      console.error(`[SupervisorPanel] ${domain}.${service} fehlgeschlagen:`, e);
      this._toast(`Fehler: ${e.message}`);
    }
  }

  /** Führt eine Aktion über die Supervisor-REST-API aus (z.B. supervisor/restart, das keine HA-Aktion hat) */
  async _apiAction(endpoint, label) {
    const ok = await this._confirm(label, 'Dies wirkt sich auf deine Home Assistant-Instanz aus.');
    if (!ok) return;
    this._toast(`${label}...`);
    try {
      await this._apiPost(endpoint);
      this._toast(`${label} eingeleitet.`);
    } catch (e) {
      console.error(`[SupervisorPanel] ${endpoint} fehlgeschlagen:`, e);
      this._toast(`Fehler: ${e.message}`);
    }
  }

  _showError(msg) {
    ['core-info', 'supervisor-info', 'host-info'].forEach(id => {
      const el = this.querySelector(`#${id}`);
      if (el) el.innerHTML = `<span style="color:#f44336">Fehler: ${this._esc(String(msg))}</span>`;
    });
  }

  _toast(msg) {
    const t = this.querySelector('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }
}

if (!customElements.get('supervisor-panel')) {
  customElements.define('supervisor-panel', SupervisorPanel);
}
