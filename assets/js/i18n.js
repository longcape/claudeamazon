/* =========================================================
   I18N
   翻訳辞書の登録・切り替え・文字列展開。
   言語を追加するときは locales/<code>.js を 1 枚足すだけでよい。
   ========================================================= */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'vct.lang';
  const FALLBACK = 'en';
  const dicts = {};
  const meta = [];
  let current = 'ja';
  const listeners = [];

  /**
   * 言語を登録する。
   * @param {string} code   BCP47 風の言語コード
   * @param {Object} info   { name: 現地語表記, flag: 絵文字 }
   * @param {Object} table  キー → 文字列
   */
  function register(code, info, table) {
    dicts[code] = table;
    meta.push({ code: code, name: info.name, flag: info.flag });
  }

  function languages() { return meta.slice(); }

  function get() { return current; }

  function set(code) {
    if (!dicts[code]) return false;
    current = code;
    try { localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* 保存できなくても動作は続行 */ }
    document.documentElement.setAttribute('lang', code);
    listeners.forEach(function (fn) { fn(code); });
    return true;
  }

  function onChange(fn) { listeners.push(fn); }

  /** 保存済み設定 → ブラウザ設定 → 日本語 の順で初期言語を決める */
  function detect() {
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* noop */ }
    if (saved && dicts[saved]) return saved;

    const navLangs = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || 'ja'];

    for (let i = 0; i < navLangs.length; i++) {
      const raw = String(navLangs[i]);
      if (dicts[raw]) return raw;
      const base = raw.split('-')[0];
      const hit = Object.keys(dicts).filter(function (code) {
        return code === base || code.split('-')[0] === base;
      })[0];
      if (hit) return hit;
    }
    return dicts.ja ? 'ja' : FALLBACK;
  }

  /**
   * 翻訳。未定義キーはフォールバック言語 → キー名の順で解決する。
   * params は {name} 形式のプレースホルダを置換する。
   */
  function t(key, params) {
    const table = dicts[current] || {};
    let str = table[key];
    if (str === undefined && dicts[FALLBACK]) str = dicts[FALLBACK][key];
    if (str === undefined) return key;
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, function (whole, name) {
      return params[name] !== undefined ? String(params[name]) : whole;
    });
  }

  /** data-i18n 属性を持つ要素をまとめて置き換える */
  function applyDom(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    (root || document).querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    (root || document).querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
  }

  global.VCT_I18N = {
    register: register,
    languages: languages,
    get: get,
    set: set,
    detect: detect,
    onChange: onChange,
    t: t,
    applyDom: applyDom
  };
})(window);
