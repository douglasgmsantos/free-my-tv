/*
 * What the home screen shows, kept in localStorage so it opens with numbers:
 *  - the picks: what's trending this week and recent releases, only from the streaming apps on this TV (TMDB, with
 *    the person's own free key from config.properties), 3 per hour (up to 6 in Home Settings);
 *  - weather, sunrise and sunset (Open-Meteo, every 30 min) and optional crypto prices (Binance, every 5 min).
 * Settings changed on the TV (Prefs) win over config.properties, as on Android. Built without a city (--generic), the
 * TV's time zone gives the city, and its country the currency and the region (zones.js).
 */
var CONFIG = window.CONFIG || {};

var Place = (function () {
  'use strict';
  var EURO = /^(AT|BE|BG|CY|DE|EE|ES|FI|FR|GR|HR|IE|IT|LT|LU|LV|MT|NL|PT|SI|SK)$/;

  /** A time zone's main city: {country, lat, lon, name}, or null. */
  function zone(name) {
    var all = window.ZONES || {}, v = all[name], hops = 0;
    while (v && v.charAt(0) === '=' && hops++ < 3) { name = v.slice(1); v = all[name]; }
    if (!v) return null;
    var p = v.split(',');
    return {country: p[0], lat: p[1], lon: p[2], name: p[3] || name.slice(name.lastIndexOf('/') + 1).replace(/_/g, ' ')};
  }

  var tz = zone(TV.zone()), set = CONFIG.latitude !== '' && CONFIG.latitude !== undefined;
  var country = (CONFIG.tmdbRegion || (tz ? tz.country : '') || 'US').toUpperCase();
  return {
    lat: set ? CONFIG.latitude : tz ? tz.lat : '40.7128',
    lon: set ? CONFIG.longitude : tz ? tz.lon : '-74.0060',
    city: CONFIG.city || (!set && tz ? tz.name : ''),
    country: country,
    currency: (CONFIG.currency || (country === 'BR' ? 'BRL' : EURO.test(country) ? 'EUR' : 'USD')).toUpperCase(),
    /** Fahrenheit for TVs in the US (by their time zone, or their language when it doesn't tell). */
    fahrenheit: tz ? tz.country === 'US' : /-US$/i.test(navigator.language || '')
  };
})();

var Prefs = (function () {
  'use strict';
  var KEY = 'fmtv.prefs';
  var v = {};
  try { v = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function pick(name, fallback) { return v[name] === undefined ? fallback : v[name]; }
  return {
    version: 0,
    language: function () { return pick('language', CONFIG.language || 'auto'); },
    temperature: function () { return pick('temperature', CONFIG.temperature || 'auto'); },
    theme: function () { return pick('theme', CONFIG.theme || 'auto'); },
    weather: function () { return pick('weather', true); },
    /** OK on the screensaver opens the title it shows, in its app; any other key only closes it (off by default). */
    saverWatch: function () { return pick('saverWatch', false) === true; },
    /** The weather card's forecast: 'hours' (the next 6 hours) or 'days' (the next 5 days). */
    forecast: function () { return pick('forecast', 'hours') === 'days' ? 'days' : 'hours'; },
    quotes: function () { return pick('quotes', CONFIG.showCrypto !== false); },
    coin: function (i) { var c = pick('coins', null); return c ? c[i] !== false : true; },
    /** Picks per tab: 3 (as it was) up to 6. */
    cards: function () { var n = pick('cards', 3); return n < 3 ? 3 : n > 6 ? 6 : n; },
    shelf: function () { return pick('shelf', null); },
    /** The shelf_apps of the build that last set the shelf, so a new one wins once over the TV's choice. */
    shelfConfig: function () { return pick('shelfConfig', ''); },
    /** The weather's city, picked on the TV (Home Settings → City), or config.properties' (or the time zone's). */
    city: function () { return pick('city', Place.city); },
    latitude: function () { return pick('latitude', Place.lat); },
    longitude: function () { return pick('longitude', Place.lon); },
    /** The TMDB key typed on the TV (Home Settings → TMDB key), or config.properties' ('' for none). */
    tmdbKey: function () { return String(pick('tmdbKey', CONFIG.tmdbKey || '')).trim(); },
    /** True when the key in use was typed on the TV (Remove takes it back to config.properties'). */
    tmdbKeyOnTV: function () { return v.tmdbKey !== undefined; },
    setCity: function (name, lat, lon) { v.city = name; v.latitude = lat; v.longitude = lon; save(); this.version++; },
    /** Streaming services (keys like "netflix") whose titles are left out of the picks. */
    serviceOff: function (key) { return pick('servicesOff', []).indexOf(key) >= 0; },
    setServiceOff: function (key, off) {
      var list = pick('servicesOff', []).filter(function (k) { return k !== key; });
      if (off) list.push(key);
      this.set('servicesOff', list);
    },
    set: function (name, value) { v[name] = value; save(); this.version++; },
    setCoin: function (i, on) {
      var c = (pick('coins', null) || [true, true, true, true]).slice();
      c[i] = on;
      this.set('coins', c);
    }
  };
})();

var Data = (function () {
  'use strict';

  function store(key, value) { try { localStorage.setItem('fmtv.' + key, JSON.stringify(value)); } catch (e) {} }
  function stored(key) { try { return JSON.parse(localStorage.getItem('fmtv.' + key)); } catch (e) { return null; } }

  /** GET a JSON document; done(error, json). */
  function get(url, headers, done) {
    var x = new XMLHttpRequest();
    var over = false;
    x.open('GET', url, true);
    x.timeout = 10000;
    for (var h in headers) if (headers.hasOwnProperty(h)) x.setRequestHeader(h, headers[h]);
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || over) return;
      over = true;
      if (x.status !== 200) { done(new Error(x.status === 401 ? 'TMDB rejected the key' : 'HTTP ' + x.status)); return; }
      var json;
      try { json = JSON.parse(x.responseText); } catch (e) { done(e); return; }
      done(null, json);
    };
    x.ontimeout = x.onerror = function () { if (!over) { over = true; done(new Error('no connection')); } };
    x.send();
  }

  var listeners = [];
  function changed() { for (var i = 0; i < listeners.length; i++) listeners[i](); }

  // MARK: - Weather

  function place() { return Prefs.latitude() + ',' + Prefs.longitude(); }
  // Both forecasts in one answer, the next 48 hours and today plus 5 days: Home Settings → Forecast switches without
  // asking again, and offline too.
  var QUERY = '&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,weather_code'
      + '&hourly=temperature_2m,weather_code,is_day&timezone=auto&forecast_days=6&forecast_hours=48';
  var weather = null, weatherAt = 0, fetchingWeather = false;
  (function () {
    var w = stored('weather');
    // Fetched with another query (an older version): shown, and fetched again now.
    if (w && w.place === place()) { weather = parseWeather(w.body); weatherAt = w.query === QUERY ? w.at : 0; }
  })();

  /** "2026-10-20T18:31" at the location (Open-Meteo's local time) → epoch ms. */
  function localTime(iso, offsetSeconds) {
    var m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(iso || '');
    if (!m) return 0;
    return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) - offsetSeconds * 1000;
  }

  function parseWeather(o) {
    if (!o || !o.current) return null;
    var off = o.utc_offset_seconds || 0, dl = o.daily, now = Date.now();
    var w = {
      temp: o.current.temperature_2m, code: o.current.weather_code, isDay: o.current.is_day !== 0,
      max: dl.temperature_2m_max[0], min: dl.temperature_2m_min[0],
      sunrise: localTime(dl.sunrise[0], off), sunset: localTime(dl.sunset[0], off), hours: [], days: []
    };
    var hr = o.hourly;
    for (var i = 0; hr && i < hr.time.length && w.hours.length < 6; i++) {
      var at = localTime(hr.time[i], off);
      if (at <= now) continue;
      w.hours.push({at: at, temp: hr.temperature_2m[i], code: hr.weather_code[i], day: !hr.is_day || hr.is_day[i] !== 0});
    }
    // The next 5 days, from tomorrow (none in a forecast cached before the days). Only days that haven't started at
    // the city: today, and past days in a forecast cached offline, are left out.
    for (var j = 0; dl.weather_code && j < dl.time.length && w.days.length < 5; j++) {
      if (localTime(dl.time[j] + 'T12:00', off) - 12 * 3600000 <= now) continue;
      var p = dl.time[j].split('-');   // named by its noon on the TV's clock, right even with the city far away
      w.days.push({at: new Date(+p[0], p[1] - 1, +p[2], 12).getTime(), max: dl.temperature_2m_max[j],
        min: dl.temperature_2m_min[j], code: dl.weather_code[j]});
    }
    return w;
  }

  function refreshWeather() {
    var now = Date.now();
    if (fetchingWeather || (now - weatherAt < 30 * 60000 && now >= weatherAt)) return;
    fetchingWeather = true;
    var at = place();
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + Prefs.latitude() + '&longitude=' + Prefs.longitude() + QUERY;
    get(url, {}, function (err, body) {
      fetchingWeather = false;
      if (at !== place()) { refreshWeather(); return; }   // another city was picked meanwhile
      if (err) return;
      weather = parseWeather(body);
      weatherAt = Date.now();
      store('weather', {place: at, body: body, at: weatherAt, query: QUERY});
      changed();
    });
  }

  /** Places with this name (Open-Meteo, in the app's language): done(error, [{label, city, lat, lon}]). */
  function findCity(name, done) {
    var lang = I18N.lang.replace(/-.*/, '');   // Open-Meteo takes the language without the country
    get('https://geocoding-api.open-meteo.com/v1/search?count=10&format=json&language=' + lang + '&name='
        + encodeURIComponent(name.trim()), {}, function (err, body) {
      if (err) { done(err); return; }
      var results = (body && body.results) || [], out = [], seen = {};
      for (var i = 0; i < results.length; i++) {
        var r = results[i], city = r.name || '';
        if (!city || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') continue;
        var label = city, parts = [r.admin1, r.country];
        for (var j = 0; j < parts.length; j++) if (parts[j] && parts[j] !== city) label += ', ' + parts[j];
        if (seen['#' + label]) continue;   // places with the same name, state and country read the same
        seen['#' + label] = true;
        out.push({label: label, city: city, lat: r.latitude.toFixed(4), lon: r.longitude.toFixed(4)});
      }
      done(null, out);
    });
  }

  // MARK: - Prices

  var COINS = ['BTC', 'ETH', 'SOL', 'USDT'];
  var CURRENCY = Place.currency;
  var QUOTE = CURRENCY === 'USD' ? 'USDT' : CURRENCY;
  /** Binance refuses the whole request when it has no pairs in the currency (INR...): the prices go in dollars then. */
  function inDollars() {
    store('dollarsFor', CURRENCY);
    CURRENCY = 'USD';
    QUOTE = 'USDT';
  }
  /** A pair with no trade for a day: Binance halted it and keeps answering with the frozen last price (AUD since 2026-10-06). */
  function halted(list) {
    for (var i = 0; list && i < list.length; i++) if (list[i].closeTime > 0 && Date.now() - list[i].closeTime > 864e5) return true;
    return false;
  }
  if (stored('dollarsFor') === CURRENCY && CURRENCY !== 'USD') {
    CURRENCY = 'USD';
    QUOTE = 'USDT';
  }
  var prices = [NaN, NaN, NaN, NaN], changes = [NaN, NaN, NaN, NaN], pricesAt = 0, fetchingPrices = false;

  /** Indexes in COINS of the coins that are on (the dollar only in Brazilian reais, where Binance lists it). */
  function activeCoins() {
    var out = [];
    if (!Prefs.quotes()) return out;
    for (var i = 0; i < COINS.length; i++) if (Prefs.coin(i) && (i < 3 || CURRENCY === 'BRL')) out.push(i);
    return out;
  }

  function parsePrices(list) {
    var found = 0;
    for (var i = 0; list && i < list.length; i++) {
      for (var k = 0; k < COINS.length; k++) {
        if (list[i].symbol !== COINS[k] + QUOTE) continue;
        found++;
        var last = parseFloat(list[i].lastPrice), open = parseFloat(list[i].openPrice);
        prices[k] = last;
        changes[k] = open > 0 ? (last - open) / open * 100 : NaN;
      }
    }
    return found;
  }

  (function () {
    var p = stored('prices');
    if (p && p.quote === QUOTE && parsePrices(p.body)) pricesAt = p.at;
  })();

  function refreshPrices() {
    var coins = activeCoins(), now = Date.now();
    if (!coins.length || fetchingPrices || (now - pricesAt < 5 * 60000 && now >= pricesAt)) return;
    fetchingPrices = true;
    var symbols = coins.map(function (i) { return '%22' + COINS[i] + QUOTE + '%22'; }).join(',');
    var path = '/api/v3/ticker/24hr?type=MINI&symbols=%5B' + symbols + '%5D';
    // Binance.com refuses the US (HTTP 451); Binance.US answers the same call in dollars.
    var hosts = ['https://api.binance.com', 'https://api.binance.us'];
    (function next(h, refused) {
      get(hosts[h] + path, {}, function (err, body) {
        // A pair Binance doesn't list (HTTP 400): the prices go in dollars. Binance.US has only dollar pairs: its 400
        // counts only where Binance.com refuses the US (HTTP 451), not after a timeout or a 5xx there.
        if (err && err.message === 'HTTP 400' && QUOTE !== 'USDT' && (h === 0 || refused)) { fetchingPrices = false; inDollars(); refreshPrices(); return; }
        // Halted: dollars for this run, not saved like the 400's (the market may open again).
        if (!err && QUOTE !== 'USDT' && halted(body)) { fetchingPrices = false; CURRENCY = 'USD'; QUOTE = 'USDT'; refreshPrices(); return; }
        if (err || !parsePrices(body)) {
          if (h + 1 < hosts.length && !(err && err.message === 'HTTP 400')) next(h + 1, err && err.message === 'HTTP 451');
          else fetchingPrices = false;
          return;
        }
        fetchingPrices = false;
        pricesAt = Date.now();
        store('prices', {quote: QUOTE, body: body, at: pricesAt});
        changed();
      });
    })(0);
  }

  // MARK: - Picks (TMDB)

  var KEY = Prefs.tmdbKey();
  var REGION = Place.country;
  var API = 'https://api.tmdb.org/3';   // TMDB's own mirror of api.themoviedb.org: some ISPs block the other name (#327)

  /** Service name on TMDB (part of it, lowercase) → our key, how to find its app on the TV (id, name), its name. */
  var SERVICES = [
    ['netflix', 'netflix', /^netflix$/, /netflix/i, 'Netflix'],
    ['prime video', 'prime', /^amazon$/, /prime video|amazon/i, 'Prime Video'],
    ['disney', 'disney', /disney/, /disney/i, 'Disney+'],
    ['hulu', 'hulu', /^hulu/, /hulu/i, 'Hulu'],
    ['paramount', 'paramount', /paramount|cbs/, /paramount/i, 'Paramount+'],
    ['peacock', 'peacock', /peacock/, /peacock/i, 'Peacock'],
    ['globoplay', 'globoplay', /globoplay/, /globoplay/i, 'Globoplay'],
    ['max', 'max', /hbo|wbd|\.max/, /^(hbo )?max$|hbo max/i, 'Max'],
    ['apple tv', 'appletv', /appletv|apple\.tv/, /apple tv/i, 'Apple TV'],
    ['hotstar', 'hotstar', /hotstar/, /hotstar/i, 'JioHotstar'],
    ['crunchyroll', 'crunchyroll', /crunchyroll/, /crunchyroll/i, 'Crunchyroll'],
    ['now tv', 'now', /nowtv|now\.tv/, /^now( tv)?$/i, 'NOW']
  ];

  var installed = [];   // the TV's apps, from TV.apps()

  /** A service whose app is on the TV and that the person hasn't switched off in Home Settings (Picks from). */
  function usable(key) { return !!appFor(key) && !Prefs.serviceOff(key); }

  /** The streaming services whose app is on this TV, as {key, name}, for Home Settings. */
  function services() {
    var out = [];
    for (var s = 0; s < SERVICES.length; s++) if (appFor(SERVICES[s][1])) out.push({key: SERVICES[s][1], name: SERVICES[s][4]});
    return out;
  }

  /** The installed app for a service key, or null. */
  function appFor(key) {
    for (var s = 0; s < SERVICES.length; s++) {
      if (SERVICES[s][1] !== key) continue;
      for (var i = 0; i < installed.length; i++) {
        if (SERVICES[s][2].test(installed[i].id) || SERVICES[s][3].test(installed[i].title)) return installed[i];
      }
    }
    return null;
  }

  /** "… Amazon Channel" is sold inside another app; Apple TV is only the streaming service (350; 2 is the store). */
  function service(providerName, providerId) {
    var n = (providerName || '').toLowerCase();
    if (n.indexOf(' channel') >= 0) return null;
    for (var i = 0; i < SERVICES.length; i++) {
      var s = SERVICES[i];
      if (s[1] === 'appletv' && providerId !== 350) continue;
      if (s[0] === 'max' ? /\bmax\b/.test(n) : n.indexOf(s[0]) >= 0) return s;
    }
    return null;
  }

  function tmdb(path, done, key) {
    key = key || KEY;
    var bearer = key.indexOf('eyJ') === 0;   // read access token (v4) or API key (v3)
    var url = API + path + (bearer ? '' : (path.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(key));
    get(url, bearer ? {Authorization: 'Bearer ' + key, Accept: 'application/json'} : {Accept: 'application/json'}, done);
  }

  /** Asks TMDB whether a key works before it's saved: done(error), with error.rejected when TMDB said no. */
  function checkKey(key, done) {
    tmdb('/configuration', function (err) {
      if (err && /rejected/.test(err.message)) err.rejected = true;
      done(err || null);
    }, key);
  }

  var cache = stored('recs') || {};
  var picks = cache.picks || [], listAt = cache.listAt || 0, period = cache.period, listLang = cache.lang || '', stamp = cache.stamp || '';
  var fetchingRecs = false, failedAt = 0, recsError = '';

  function saveRecs() { store('recs', {picks: picks, listAt: listAt, period: period, lang: listLang, stamp: stamp}); }

  function hourPeriod(d) {
    var h = d.getHours();
    return h >= 5 && h < 12 ? 0 : h >= 12 && h < 18 ? 1 : 2;
  }

  function sourceStamp() {
    var s = KEY.length + ':' + KEY.slice(-6) + ':' + REGION + (CONFIG.hideAnimation ? ':no-animation' : '');
    for (var i = 0; i < SERVICES.length; i++) s += usable(SERVICES[i][1]) ? '1' : '0';
    return s;
  }

  function franchise(title) {
    var t = (title || '').toLowerCase(), cut = t.indexOf(':');
    if (cut < 0) cut = t.indexOf(' - ');
    return (cut > 0 ? t.slice(0, cut) : t).replace(/^\s+|\s+$/g, '');
  }

  /** This hour's picks (Prefs.cards()): movies ("movie"), shows ("tv") or both (null). */
  function now(kind) {
    var list = [];
    if (!KEY) return list;
    for (var i = 0; i < picks.length; i++) {
      var p = picks[i];
      if ((kind === null || kind === p.kind) && (!p.detailed || (p.app && usable(p.app)))) list.push(p);
    }
    if (!list.length) return list;
    var hour = Math.floor(Date.now() / 3600000), out = [], seen = {}, n = Prefs.cards();
    for (var j = 0; j < list.length && out.length < n; j++) {
      var q = list[(hour * n + j) % list.length], f = franchise(q.title);
      if (!seen[f]) { seen[f] = true; out.push(q); }
    }
    return out;
  }

  /** TMDB's language, as on Android: Latin American Spanish unless the TV is in Spain, and Germany's German. */
  function lang() {
    if (I18N.lang === 'es') return /-ES\b/i.test(navigator.language || '') ? 'es-ES' : 'es-MX';
    if (I18N.lang === 'de') return 'de-DE';   // TMDB's de-AT and de-CH have few translations of their own
    return I18N.locale();
  }

  function day(offset) {
    var d = new Date(Date.now() + offset * 86400000);
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  /** TMDB's genres that it leaves in English in some languages. */
  function genre(name) {
    switch (name) {
      case 'Action & Adventure': return tr('genre|Action & Adventure');
      case 'Sci-Fi & Fantasy': return tr('genre|Sci-Fi & Fantasy');
      case 'War & Politics': return tr('genre|War & Politics');
      case 'Kids': return tr('genre|Kids');
      case 'News': return tr('genre|News');
      case 'Soap': return tr('genre|Soap');
      case 'Talk': return tr('genre|Talk');
      default: return name;
    }
  }

  /** The best backdrop: no text over it, the largest, then the best rated. */
  function bestBackdrop(images) {
    var list = images && images.backdrops, best = null, score = -1;
    for (var i = 0; list && i < list.length; i++) {
      var b = list[i];
      if (!b.file_path) continue;
      var s = (b.iso_639_1 === null ? 1e7 : 0) + Math.min(b.width || 0, 3840) * 100 + (b.vote_average || 0);
      if (s > score) { score = s; best = b.file_path; }
    }
    return best;
  }

  /** Genre, runtime or seasons, and the service it's on among the TV's apps. */
  function details(p, done) {
    tmdb('/' + p.kind + '/' + p.id + '?language=' + lang() + '&append_to_response=watch/providers,images&include_image_language=null,'
        + I18N.base + ',en', function (err, o) {
      if (err) { done(err); return; }
      var best = bestBackdrop(o.images);
      if (best) p.backdrop = best;
      if (o.poster_path) p.poster = o.poster_path;
      var parts = [];
      if (p.kind === 'tv') parts.push(tr('Series'));
      if (o.genres && o.genres.length) {
        parts.push(genre(o.genres[0].name));
      }
      if (p.kind === 'movie' && o.runtime > 0) {
        var h = Math.floor(o.runtime / 60), m = o.runtime % 60;
        parts.push(h ? trf('{h}h {m}m', {h: h, m: m}) : trf('{m}m', {m: m}));
      } else if (p.kind === 'tv' && o.number_of_seasons > 0) {
        parts.push(plural('plural|one:{n} season|other:{n} seasons', o.number_of_seasons));
      }
      var wp = o['watch/providers'], here = wp && wp.results && wp.results[REGION], flat = here && here.flatrate;
      p.app = null;
      for (var i = 0; flat && i < flat.length && !p.app; i++) {
        var s = service(flat[i].provider_name, flat[i].provider_id);
        if (s && usable(s[1])) { p.app = s[1]; p.service = s[4]; }
      }
      if (p.service && p.app) parts.push(p.service);
      p.meta = parts.join(' · ');
      title(p, o, function () {
        p.detailed = true;
        done(null);
      });
    });
  }

  /**
   * Without a title in the TV's language TMDB answers with the original one, so a Korean series on a German TV reads
   * "닥터X: 하얀 마피아의 시대". Then the English title, when TMDB has one (one more request, only for those).
   */
  function title(p, o, done) {
    var field = p.kind === 'movie' ? 'title' : 'name', own = o[field] || p.title;
    p.title = own;
    if (I18N.lang === 'en' || !own || own !== o['original_' + field] || o.original_language === I18N.base
        || o.original_language === 'en') { done(); return; }
    tmdb('/' + p.kind + '/' + p.id + '?language=en-US', function (err, en) {
      if (!err && en && en[field]) p.title = en[field];
      done();
    });
  }

  /** TMDB's Animation genre (movies and shows: cartoons and anime), left out with hide_animation=true. */
  var ANIMATION = 16;

  function animated(o) {
    for (var i = 0; o.genre_ids && i < o.genre_ids.length; i++) if (o.genre_ids[i] === ANIMATION) return true;
    return false;
  }

  function addPick(list, o, kind) {
    if (!o.backdrop_path) return;
    if (CONFIG.hideAnimation && animated(o)) return;
    list.push({id: o.id, kind: kind, title: kind === 'movie' ? o.title : o.name, backdrop: o.backdrop_path, poster: o.poster_path || '', meta: '', app: null, detailed: false});
  }

  function keyOf(p) { return p.kind + ':' + p.id; }

  function alternate(out, seen, a, b, max) {
    for (var i = 0; i < Math.max(a.length, b.length) && out.length < max; i++) {
      if (i < a.length && !seen[keyOf(a[i])]) { seen[keyOf(a[i])] = true; out.push(a[i]); }
      if (i < b.length && out.length < max && !seen[keyOf(b[i])]) { seen[keyOf(b[i])] = true; out.push(b[i]); }
    }
  }

  /** Runs fn on each item one after the other (the TV's network is shared with what's playing). */
  function each(items, fn, done) {
    var i = 0;
    (function next() {
      if (i >= items.length) { done(); return; }
      fn(items[i++], next);
    })();
  }

  function fetchList(done) {
    tmdb('/watch/providers/movie?language=' + lang() + '&watch_region=' + REGION, function (err, res) {
      if (err) { done(err); return; }
      var ids = [];
      for (var i = 0; res.results && i < res.results.length; i++) {
        var s = service(res.results[i].provider_name, res.results[i].provider_id);
        if (s && usable(s[1])) ids.push(res.results[i].provider_id);
      }
      if (!ids.length) { done(new Error("none of the TV's streaming apps are on TMDB (or switched on in Picks from)")); return; }
      var common = '&language=' + lang() + '&watch_region=' + REGION + '&with_watch_monetization_types=flatrate&include_adult=false'
          + '&sort_by=popularity.desc&with_watch_providers=' + encodeURIComponent(ids.join('|'))
          + (CONFIG.hideAnimation ? '&without_genres=' + ANIMATION : '');
      var hot = {movie: [], tv: []}, fresh = {movie: [], tv: []};
      each(['movie', 'tv'], function (kind, next) {
        tmdb('/trending/' + kind + '/week?language=' + lang(), function (e, r) {
          var candidates = [];
          for (var j = 0; !e && j < r.results.length && j < 16; j++) addPick(candidates, r.results[j], kind);
          // Trending is only kept when it's on one of the TV's apps: the details say where.
          each(candidates, function (p, n) {
            details(p, function (de) { if (!de && p.app) hot[kind].push(p); n(); });
          }, next);
        });
      }, function () {
        tmdb('/discover/movie?vote_count.gte=30&primary_release_date.gte=' + day(-365) + '&primary_release_date.lte=' + day(0) + common, function (e1, r1) {
          for (var j = 0; !e1 && j < r1.results.length; j++) addPick(fresh.movie, r1.results[j], 'movie');
          tmdb('/discover/tv?vote_count.gte=20&air_date.gte=' + day(-90) + '&air_date.lte=' + day(0) + common, function (e2, r2) {
            for (var k = 0; !e2 && k < r2.results.length; k++) addPick(fresh.tv, r2.results[k], 'tv');
            var list = [], seen = {};
            alternate(list, seen, hot.movie, hot.tv, 24);
            alternate(list, seen, fresh.movie, fresh.tv, 24);
            if (!list.length) { done(new Error('TMDB returned no recommendations')); return; }
            picks = list;
            done(null);
          });
        });
      });
    });
  }

  /** Fetches the list when stale (6 h, a new period of the day, language, key or apps), then this hour's details. */
  function refreshRecs() {
    if (!KEY || fetchingRecs || !installed.length) return;
    var t = Date.now(), p = hourPeriod(new Date()), st = sourceStamp();
    if (st === stamp && failedAt && t - failedAt < 10 * 60000 && t >= failedAt) return;
    var stale = st !== stamp || p !== period || t - listAt > 6 * 3600000 || t < listAt || !picks.length || listLang !== I18N.lang;
    var wanted = all(), missing = false;
    for (var i = 0; i < wanted.length; i++) missing = missing || !wanted[i].detailed;
    if (!stale && !missing) return;
    fetchingRecs = true;
    stamp = st;
    function finish(err) {
      fetchingRecs = false;
      if (err) { recsError = err.message; failedAt = Date.now(); } else { recsError = ''; failedAt = 0; }
      saveRecs();
      changed();
    }
    function detailWanted() {
      var todo = all().filter(function (x) { return !x.detailed; });
      each(todo, function (x, next) { details(x, function () { next(); }); }, function () { finish(null); });
    }
    if (stale) {
      fetchList(function (err) {
        if (err) { finish(err); return; }
        listAt = Date.now();
        pages = {movie: 1, tv: 1};
        exhausted = {movie: false, tv: false};
        period = p;
        listLang = I18N.lang;
        detailWanted();
      });
    } else {
      detailWanted();
    }
  }

  /** This hour's picks for the three tabs, without repeats (the screensaver shows them too). */
  function all() {
    var out = [], seen = {}, kinds = [null, 'movie', 'tv'];
    for (var k = 0; k < kinds.length; k++) {
      var list = now(kinds[k]);
      for (var i = 0; i < list.length; i++) if (!seen[keyOf(list[i])]) { seen[keyOf(list[i])] = true; out.push(list[i]); }
    }
    return out;
  }

  var PRELOAD = 6, POOL_MAX = 400;
  var pages = {movie: 1, tv: 1}, exhausted = {movie: false, tv: false}, loadingMore = {};

  function fits(kind, p) { return kind === null || kind === p.kind; }

  function row(kind) {
    var out = [];
    if (!KEY) return out;
    for (var i = 0; i < picks.length; i++) {
      var p = picks[i];
      if (fits(kind, p) && p.detailed && p.app && usable(p.app)) out.push(p);
    }
    return out;
  }

  function undetailed(kind) {
    return picks.filter(function (p) { return fits(kind, p) && !p.detailed; });
  }

  function fetchPage(kind, done) {
    var page = ++pages[kind];
    tmdb('/watch/providers/movie?language=' + lang() + '&watch_region=' + REGION, function (err, res) {
      if (err) { done(err); return; }
      var ids = [];
      for (var i = 0; res.results && i < res.results.length; i++) {
        var s = service(res.results[i].provider_name, res.results[i].provider_id);
        if (s && usable(s[1])) ids.push(res.results[i].provider_id);
      }
      if (!ids.length) { exhausted[kind] = true; done(null); return; }
      var path = '/discover/' + kind + '?page=' + page + '&language=' + lang() + '&watch_region=' + REGION
          + '&with_watch_monetization_types=flatrate&include_adult=false&sort_by=popularity.desc&with_watch_providers='
          + encodeURIComponent(ids.join('|')) + (CONFIG.hideAnimation ? '&without_genres=' + ANIMATION : '')
          + (kind === 'movie' ? '&vote_count.gte=30' : '&vote_count.gte=20');
      tmdb(path, function (e, r) {
        if (e) { done(e); return; }
        var seen = {};
        for (var j = 0; j < picks.length; j++) seen[keyOf(picks[j])] = true;
        var found = [];
        for (var k = 0; r.results && k < r.results.length; k++) {
          if (!seen[kind + ':' + r.results[k].id]) addPick(found, r.results[k], kind);
        }
        if (!r.results || !r.results.length || page >= (r.total_pages || 1)) exhausted[kind] = true;
        picks = picks.concat(found).slice(0, POOL_MAX);
        if (picks.length >= POOL_MAX) exhausted[kind] = true;
        done(null);
      });
    });
  }

  function more(kind) {
    var tag = String(kind);
    if (!KEY || loadingMore[tag] || fetchingRecs || !installed.length) return;
    var todo = undetailed(kind).slice(0, PRELOAD);
    if (todo.length) {
      loadingMore[tag] = true;
      changed();
      each(todo, function (p, next) { details(p, function () { changed(); next(); }); }, function () {
        loadingMore[tag] = false;
        saveRecs();
        changed();
      });
      return;
    }
    var kinds = kind === null ? ['movie', 'tv'] : [kind];
    kinds = kinds.filter(function (k) { return !exhausted[k]; });
    if (!kinds.length) return;
    loadingMore[tag] = true;
    changed();
    each(kinds, function (k, next) { fetchPage(k, function () { next(); }); }, function () {
      loadingMore[tag] = false;
      if (undetailed(kind).length) more(kind); else changed();
    });
  }

  function fresh(kind) {
    var tag = String(kind);
    if (!KEY || loadingMore[tag] || fetchingRecs || !installed.length) return;
    var kinds = (kind === null ? ['movie', 'tv'] : [kind]).filter(function (k) { return !exhausted[k]; });
    if (!kinds.length) { more(kind); return; }
    loadingMore[tag] = true;
    each(kinds, function (k, next) { fetchPage(k, function () { next(); }); }, function () {
      loadingMore[tag] = false;
      more(kind);
    });
  }

  function canGrow(kind) {
    if (!KEY) return false;
    if (undetailed(kind).length) return true;
    return kind === null ? !exhausted.movie || !exhausted.tv : !exhausted[kind];
  }

  var YT_KEY = (CONFIG.youtubeKey || '').trim();
  var YT_CLIENT = (CONFIG.youtubeClientId || '').trim(), YT_SECRET = (CONFIG.youtubeClientSecret || '').trim();
  var YT_API = 'https://www.googleapis.com/youtube/v3/', OAUTH = 'https://oauth2.googleapis.com/';
  var YT_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
  var ytCache = stored('youtube') || {};
  var videos = ytCache.videos || [], ytAt = ytCache.at || 0, ytToken = ytCache.token || '', ytDone = !!ytCache.done;
  var feedDone = !!ytCache.feedDone;
  var ytLoading = false, ytError = '';
  var auth = stored('ytauth') || null, login = null, loginTimer = 0;
  var SHORTS_MAX = 180, CHANNELS_MAX = 60, PER_CHANNEL = 4, FEED_DAYS = 21;

  function ytApp() {
    for (var i = 0; i < installed.length; i++) {
      if (/youtube\.leanback|TizenYouTube$/.test(installed[i].id) || /^youtube$/i.test(installed[i].title)) return installed[i];
    }
    return null;
  }

  function seconds(iso) {
    var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  function clockOf(s) {
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return h ? h + ':' + two(m) + ':' + two(x) : m + ':' + two(x);
  }

  function views(n) {
    if (!(n > 0)) return '';
    if (n >= 1e6) return trf('{n} M views', {n: fmt(n / 1e6, 1)});
    if (n >= 1e3) return trf('{n} K views', {n: fmt(n / 1e3, 0)});
    return trf('{n} views', {n: fmt(n, 0)});
  }

  function isShort(v, secs) {
    var text = ((v.snippet && v.snippet.title) || '') + ' ' + ((v.snippet && v.snippet.description) || '');
    return secs <= SHORTS_MAX || /#shorts?\b/i.test(text);
  }

  function thumbOf(t) {
    var best = t && (t.maxres || t.standard || t.high || t.medium);
    return best ? best.url : '';
  }

  function form(url, fields, done) {
    var x = new XMLHttpRequest(), over = false, body = [];
    for (var k in fields) if (fields.hasOwnProperty(k)) body.push(k + '=' + encodeURIComponent(fields[k]));
    x.open('POST', url, true);
    x.timeout = 10000;
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || over) return;
      over = true;
      var json = null;
      try { json = JSON.parse(x.responseText); } catch (e) {}
      done(x.status, json || {});
    };
    x.ontimeout = function () { if (!over) { over = true; done(0, {}); } };
    x.send(body.join('&'));
  }

  function signedIn() { return !!(auth && auth.refresh); }

  function signOut() {
    auth = null;
    later = [];
    laterAt = 0;
    laterMissing = false;
    store('ytauth', null);
    resetVideos();
    changed();
  }

  function accessToken(done) {
    if (!signedIn()) { done(null); return; }
    if (auth.access && Date.now() < auth.exp - 60000) { done(auth.access); return; }
    form(OAUTH + 'token', {client_id: YT_CLIENT, client_secret: YT_SECRET, refresh_token: auth.refresh, grant_type: 'refresh_token'},
      function (status, res) {
        if (status === 200 && res.access_token) {
          auth.access = res.access_token;
          auth.exp = Date.now() + (res.expires_in || 3600) * 1000;
          store('ytauth', auth);
          done(auth.access);
          return;
        }
        if (res.error === 'invalid_grant') { ytError = 'signed-out'; signOut(); }
        done(null);
      });
  }

  function startLogin() {
    if (!YT_CLIENT || (login && login.code)) return;
    login = {asking: true};
    changed();
    form(OAUTH + 'device/code', {client_id: YT_CLIENT, scope: YT_SCOPE}, function (status, res) {
      if (status !== 200 || !res.device_code) { login = {failed: res.error_description || res.error || 'HTTP ' + status}; changed(); return; }
      login = {code: res.user_code, url: res.verification_url || 'google.com/device', device: res.device_code,
        every: (res.interval || 5) * 1000, until: Date.now() + (res.expires_in || 1800) * 1000};
      changed();
      pollLogin();
    });
  }

  function pollLogin() {
    clearTimeout(loginTimer);
    if (!login || !login.device) return;
    if (Date.now() > login.until) { login = null; changed(); return; }
    loginTimer = setTimeout(function () {
      form(OAUTH + 'token', {client_id: YT_CLIENT, client_secret: YT_SECRET, device_code: login.device,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'}, function (status, res) {
        if (!login) return;
        if (status === 200 && res.refresh_token) {
          auth = {refresh: res.refresh_token, access: res.access_token, exp: Date.now() + (res.expires_in || 3600) * 1000};
          store('ytauth', auth);
          login = null;
          ytError = '';
          resetVideos();
          laterAt = 0;
          ytMore();
          changed();
          return;
        }
        if (res.error === 'slow_down') login.every += 5000;
        if (res.error === 'access_denied' || res.error === 'expired_token') { login = null; changed(); return; }
        pollLogin();
      });
    }, login.every);
  }

  function ytGet(path, token, done) {
    var url = YT_API + path + (token ? '' : '&key=' + encodeURIComponent(YT_KEY));
    get(url, token ? {Authorization: 'Bearer ' + token, Accept: 'application/json'} : {Accept: 'application/json'}, done);
  }

  function toVideo(v, keepShorts) {
    var secs = seconds(v.contentDetails && v.contentDetails.duration);
    if ((!keepShorts && isShort(v, secs)) || !thumbOf(v.snippet.thumbnails)) return null;
    var parts = [v.snippet.channelTitle, clockOf(secs), views(+(v.statistics && v.statistics.viewCount))].filter(function (s) { return s; });
    return {id: v.id, kind: 'youtube', title: v.snippet.title, thumb: thumbOf(v.snippet.thumbnails), meta: parts.join(' · '),
      app: 'youtube', at: Date.parse(v.snippet.publishedAt) || 0};
  }

  function addVideos(list) {
    var seen = {};
    for (var i = 0; i < videos.length; i++) seen[videos[i].id] = true;
    for (var j = 0; j < list.length; j++) if (list[j] && !seen[list[j].id]) { seen[list[j].id] = true; videos.push(list[j]); }
  }

  function saveVideos() {
    if (!ytAt) ytAt = Date.now();
    store('youtube', {videos: videos, at: ytAt, token: ytToken, done: ytDone, feedDone: feedDone});
  }

  function resetVideos() { videos = []; ytToken = ''; ytDone = false; feedDone = false; ytAt = 0; }

  function inBatches(items, size, fn, done) {
    var i = 0, running = 0;
    (function fill() {
      if (i >= items.length && !running) { done(); return; }
      while (running < size && i < items.length) {
        running++;
        fn(items[i++], function () { running--; fill(); });
      }
    })();
  }

  function loadFeed(token) {
    var channels = [], recent = [], since = Date.now() - FEED_DAYS * 86400000;
    (function page(next) {
      ytGet('subscriptions?part=snippet&mine=true&maxResults=50&order=relevance' + (next ? '&pageToken=' + next : ''), token, function (err, res) {
        if (err) { finishFeed(err); return; }
        for (var i = 0; res.items && i < res.items.length; i++) channels.push(res.items[i].snippet.resourceId.channelId);
        if (res.nextPageToken && channels.length < CHANNELS_MAX) { page(res.nextPageToken); return; }
        inBatches(channels.slice(0, CHANNELS_MAX), 4, function (channel, done) {
          ytGet('playlistItems?part=contentDetails&maxResults=' + PER_CHANNEL + '&playlistId=UU' + channel.slice(2), token, function (e, r) {
            for (var j = 0; !e && r.items && j < r.items.length; j++) {
              var c = r.items[j].contentDetails;
              if (Date.parse(c.videoPublishedAt) > since) recent.push(c.videoId);
            }
            done();
          });
        }, function () {
          var found = [], chunks = [];
          for (var k = 0; k < recent.length; k += 50) chunks.push(recent.slice(k, k + 50));
          inBatches(chunks, 1, function (ids, done) {
            ytGet('videos?part=snippet,contentDetails,statistics&id=' + ids.join(','), token, function (e, r) {
              for (var m = 0; !e && r.items && m < r.items.length; m++) found.push(toVideo(r.items[m]));
              done();
            });
          }, function () {
            found = found.filter(function (v) { return v; }).sort(function (a, b) { return b.at - a.at; });
            addVideos(found);
            finishFeed(null);
          });
        });
      });
    })('');
  }

  function finishFeed(err) {
    ytLoading = false;
    feedDone = true;
    if (err) ytError = err.message;
    saveVideos();
    changed();
    if (videos.length < PRELOAD + 3) ytMore();
  }

  function ytMore() {
    if (ytLoading || !ytApp()) return;
    if (signedIn() && !feedDone) {
      ytLoading = true;
      changed();
      accessToken(function (token) {
        if (!token) { ytLoading = false; feedDone = true; changed(); ytMore(); return; }
        loadFeed(token);
      });
      return;
    }
    if (!YT_KEY || ytDone) return;
    ytLoading = true;
    changed();
    ytGet('videos?part=snippet,contentDetails,statistics&chart=mostPopular&maxResults=25&regionCode=' + REGION
        + '&hl=' + encodeURIComponent(I18N.base) + (ytToken ? '&pageToken=' + encodeURIComponent(ytToken) : ''), null, function (err, res) {
      ytLoading = false;
      if (err) { ytError = err.message; ytDone = true; changed(); return; }
      var list = [];
      for (var j = 0; res.items && j < res.items.length; j++) list.push(toVideo(res.items[j]));
      addVideos(list);
      ytToken = res.nextPageToken || '';
      ytDone = !ytToken;
      saveVideos();
      changed();
      if (videos.length < PRELOAD + 3 && !ytDone) ytMore();
    });
  }

  function refreshYouTube() {
    if (!YT_KEY && !signedIn()) return;
    var t = Date.now();
    if (t - ytAt > 3 * 3600000 || t < ytAt) { resetVideos(); ytError = ''; }
    if (!videos.length) ytMore();
  }

  var LATER_NAME = (CONFIG.youtubePlaylist || 'TV').trim(), LATER_FRESH = 2 * 60000;
  var later = [], laterAt = 0, laterLoading = false, laterMissing = false, laterError = '';

  function findPlaylist(token, done) {
    var wanted = LATER_NAME.toLowerCase();
    (function page(next) {
      ytGet('playlists?part=snippet&mine=true&maxResults=50' + (next ? '&pageToken=' + next : ''), token, function (err, res) {
        if (err) { done(err); return; }
        for (var i = 0; res.items && i < res.items.length; i++) {
          if ((res.items[i].snippet.title || '').trim().toLowerCase() === wanted) { done(null, res.items[i].id); return; }
        }
        if (res.nextPageToken) page(res.nextPageToken); else done(null, null);
      });
    })('');
  }

  function loadLater() {
    if (laterLoading || !signedIn() || !ytApp()) return;
    laterLoading = true;
    changed();
    function finish(err) {
      laterLoading = false;
      laterError = err ? err.message : '';
      laterAt = Date.now();
      changed();
    }
    accessToken(function (token) {
      if (!token) { finish(new Error('signed out')); return; }
      findPlaylist(token, function (err, id) {
        if (err) { finish(err); return; }
        laterMissing = !id;
        if (!id) { later = []; finish(null); return; }
        var items = [];
        (function page(next) {
          ytGet('playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=' + id + (next ? '&pageToken=' + next : ''), token, function (e, r) {
            if (e) { finish(e); return; }
            for (var j = 0; r.items && j < r.items.length; j++) {
              items.push({id: r.items[j].contentDetails.videoId, added: Date.parse(r.items[j].snippet.publishedAt) || 0});
            }
            if (r.nextPageToken && items.length < 200) { page(r.nextPageToken); return; }
            var added = {}, chunks = [], found = [];
            for (var a = 0; a < items.length; a++) added[items[a].id] = items[a].added;
            for (var k = 0; k < items.length; k += 50) chunks.push(items.slice(k, k + 50).map(function (x) { return x.id; }));
            inBatches(chunks, 1, function (ids, done) {
              ytGet('videos?part=snippet,contentDetails,statistics&id=' + ids.join(','), token, function (e2, r2) {
                for (var m = 0; !e2 && r2.items && m < r2.items.length; m++) {
                  var v = toVideo(r2.items[m], true);
                  if (v) { v.at = added[v.id] || v.at; found.push(v); }
                }
                done();
              });
            }, function () {
              later = found.sort(function (x, y) { return y.at - x.at; });
              finish(null);
            });
          });
        })('');
      });
    });
  }

  function loginCard(title) {
    var card = {id: 'yt-login', kind: 'ytlogin', app: 'youtube', title: title};
    if (login && login.code) { card.code = login.code; card.meta = trf('On your phone, open {url} and enter the code', {url: login.url.replace(/^https?:\/\/(www\.)?/, '')}); }
    else if (login && login.asking) card.meta = tr('Getting a code…');
    else if (login && login.failed) card.meta = trf("Couldn't get a code: {error}", {error: login.failed});
    else card.meta = tr('Press OK to connect your YouTube account');
    return card;
  }

  function laterRow() {
    if (!ytApp()) return [];
    if (!signedIn()) return [loginCard(tr('Watch Later'))];
    if (!laterAt && !laterLoading) loadLater();
    if (laterMissing) return [{id: 'yt-later-missing', kind: 'ytinfo', app: 'youtube', code: LATER_NAME, title: tr('Watch Later'),
      meta: trf('Create a playlist named "{name}" on YouTube and save videos to it', {name: LATER_NAME})}];
    if (laterAt && !laterLoading && !later.length) return [{id: 'yt-later-empty', kind: 'ytinfo', app: 'youtube', code: LATER_NAME,
      title: tr('Watch Later'), meta: trf('Your "{name}" playlist is empty', {name: LATER_NAME})}];
    return later;
  }

  function ytRow() {
    if (!ytApp()) return [];
    if (!YT_CLIENT || signedIn()) return videos;
    var card = loginCard(tr('Videos from your subscriptions'));
    return [card].concat(videos);
  }

  // MARK: - Formatting

  function fmt(v, digits) {
    // Old WebKit (Tizen 2) has no Intl: toLocaleString ignores its options and prints every digit, without failing.
    // English separators there; a per-language table if someone asks.
    if (typeof Intl === 'undefined') return v.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    try { return v.toLocaleString(I18N.locale(), {minimumFractionDigits: digits, maximumFractionDigits: digits}); } catch (e) { return v.toFixed(digits); }
  }

  var SYMBOLS = {USD: '$', BRL: 'R$ ', EUR: '€', GBP: '£', JPY: '¥'};

  return {
    COINS: COINS,
    get city() { return Prefs.city(); },
    currency: CURRENCY,
    onChange: function (fn) { listeners.push(fn); },
    setApps: function (apps) { installed = apps; },
    appFor: appFor,
    usable: usable,
    services: services,
    refresh: function () { refreshWeather(); refreshPrices(); refreshRecs(); refreshYouTube(); },
    row: function (kind) { return kind === 'youtube' ? ytRow() : kind === 'later' ? laterRow() : row(kind); },
    reloadLater: function () { if (signedIn() && (Date.now() - laterAt > LATER_FRESH || laterError)) loadLater(); },
    hasWatchLater: function () { return !!YT_CLIENT; },
    youTubeLogin: startLogin,
    youTubeSignedIn: signedIn,
    youTubeSignOut: signOut,
    more: function (kind) { if (kind === 'youtube') ytMore(); else if (kind !== 'later') more(kind); },
    fresh: function (kind) { if (kind !== 'youtube' && kind !== 'later') fresh(kind); },
    loading: function (kind) { return kind === 'youtube' ? ytLoading : kind === 'later' ? laterLoading : !!loadingMore[String(kind)] || fetchingRecs; },
    canGrow: function (kind) {
      if (kind === 'later') return false;
      return kind === 'youtube' ? (signedIn() && !feedDone) || (!!YT_KEY && !ytDone) : canGrow(kind);
    },
    hasYouTube: function () { return !!YT_KEY || !!YT_CLIENT; },
    youTubeApp: ytApp,
    youTubeError: function () { return ytError; },
    settingsChanged: function () { pricesAt = 0; refreshPrices(); changed(); },
    findCity: findCity,
    /** Another city picked: its weather now (none shown until it comes). */
    cityChanged: function () { weather = null; weatherAt = 0; refreshWeather(); changed(); },
    get weather() { return weather; },
    get weatherAt() { return weatherAt; },
    prices: prices,
    changes: changes,
    get pricesAt() { return pricesAt; },
    activeCoins: activeCoins,
    hasKey: function () { return !!KEY; },
    checkKey: checkKey,
    /** A key typed (or removed) on the TV: the picks come again with it, or go. */
    keyChanged: function () { KEY = Prefs.tmdbKey(); recsError = ''; failedAt = 0; refreshRecs(); changed(); },
    recsError: function () { return recsError; },
    picks: now,
    showcase: all,
    image: function (path, size) { return path ? 'https://image.tmdb.org/t/p/' + (size || 'w1280') + path : ''; },

    /** Night at the location: from sunset to sunrise (the last forecast; without one, 6:00 and 18:00). */
    isNight: function (at) {
      var theme = Prefs.theme();
      if (theme === 'dark') return true;
      if (theme === 'light') return false;
      var d = new Date(at), mins = d.getHours() * 60 + d.getMinutes();
      function hm(t, fallback) { if (!t) return fallback; var x = new Date(t); return x.getHours() * 60 + x.getMinutes(); }
      var rise = hm(weather && weather.sunrise, 360), set = hm(weather && weather.sunset, 1080);
      return mins < rise || mins >= set;
    },

    compact: function (v) {
      if (isNaN(v)) return '—';
      if (v >= 1000000) return fmt(v / 1000000, 2) + 'M';
      if (v >= 10000) return fmt(v / 1000, 1) + 'k';
      if (v >= 1000) return fmt(v / 1000, 2) + 'k';
      if (v >= 100) return fmt(v, 0);
      return fmt(v, 2);
    },
    money: function (v) {
      var s = SYMBOLS[CURRENCY] || CURRENCY + ' ';
      if (isNaN(v)) return s + '—';
      return s + (v >= 1000 ? fmt(v, 0) : fmt(v, 2));
    },
    change: function (v) { return isNaN(v) ? '' : (v >= 0 ? '+' : '−') + fmt(Math.abs(v), 1) + '%'; },
    degrees: function (v) {
      if (v === undefined || v === null || isNaN(v)) return '—';
      var unit = Prefs.temperature();
      var f = unit === 'F' || (unit === 'auto' && Place.fahrenheit);
      return Math.round(f ? v * 9 / 5 + 32 : v) + '°';
    },
    /** "3 PM", "15:00", "15 Uhr": the hourly forecast. */
    hour: function (at) { return formatDate('format|h a', at); },
    /** "Seg", "Mon", "Lun", "Mo", "Пн": the short day of the week, capitalized and without the abbreviation's dot. */
    weekday: function (at) {
      var s = formatDate('format|EEE', at).replace(/\.$/, '');
      return s.charAt(0).toUpperCase() + s.substring(1);
    },
    /** "5:21 AM", "05:21": the clock, sunrise and sunset. */
    time: function (at) { return formatDate('format|h:mm a', at); },
    /** "12 min ago" when the data is old (no internet), or empty. */
    staleness: function (at, every) {
      if (!at) return '';
      var age = Date.now() - at;
      if (age < every * 2) return '';
      var m = Math.floor(age / 60000), h = Math.floor(m / 60);
      return m < 60 ? trf('{n} min ago', {n: m}) : trf('{n} h ago', {n: h});
    },
    condition: function (code, day) {
      if (code === undefined || code === null || code < 0) return '';
      if (code === 0) return day ? tr('Clear') : tr('night|Clear');
      if (code === 1) return day ? tr('Mostly Sunny') : tr('Mostly Clear');
      if (code === 2) return tr('Partly Cloudy');
      if (code === 3) return tr('Cloudy');
      if (code === 45 || code === 48) return tr('Fog');
      if (code >= 51 && code <= 57) return tr('Drizzle');
      if (code === 65 || code === 67 || code === 82) return tr('Heavy Rain');
      if ((code >= 71 && code <= 77) || code === 85 || code === 86) return tr('Snow');
      if (code >= 95) return tr('Thunderstorms');
      return tr('Rain');
    },
    symbol: function (code, day) {
      if (code <= 1) return day ? 'sunny' : 'clear_night';
      if (code === 2) return day ? 'partly_cloudy_day' : 'partly_cloudy_night';
      if (code === 3) return 'cloud';
      if (code === 45 || code === 48) return 'foggy';
      if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snowflake';
      if (code >= 95) return 'thunderstorm';
      return 'rainy';
    },
    coinName: function (i) { return i === 3 ? tr('Dollar') : ['Bitcoin', 'Ethereum', 'Solana'][i]; }
  };
})();
