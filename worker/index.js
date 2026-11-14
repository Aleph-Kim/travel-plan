// 개인 여행 일정이라 검색 엔진이 화면과 데이터를 수집하지 않게 합니다.
const noIndex = { 'X-Robots-Tag': 'noindex, nofollow' };
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ...noIndex };
const dataRoot = '/travle-plan/data/';

async function travelData(db, path) {
  if (path === dataRoot + 'trips.json') {
    const { results } = await db.prepare(
      'SELECT slug, name_json, starts_on, ends_on FROM trips ORDER BY starts_on, slug',
    ).all();
    return Response.json(results.map((trip) => ({
      slug: trip.slug, name: JSON.parse(trip.name_json), start: trip.starts_on, end: trip.ends_on,
    })), { headers: jsonHeaders });
  }

  const match = path.slice(dataRoot.length).match(/^([\da-z-]+)\/(plan|i18n|weather)\.json$/);
  if (!match) return new Response('Not found', { status: 404 });

  const [, slug, kind] = match;
  const body = kind === 'plan'
    ? await db.prepare('SELECT body FROM trip_plan_documents WHERE slug = ?').bind(slug).first('body')
    : await db.prepare('SELECT body FROM trip_documents WHERE slug = ? AND kind = ?').bind(slug, kind).first('body');
  return body === null || body === undefined
    ? new Response('Not found', { status: 404 })
    : new Response(body, { headers: jsonHeaders });
}

function webAsset(url) {
  const path = url.pathname;
  const dashboard = ['/', '/index.html', '/travle-plan/', '/travle-plan/index.html'].includes(path);
  const assetPath = dashboard ? '/index.html' : path.endsWith('/') ? path + 'index.html' : path;
  if (Object.hasOwn(assets, assetPath)) {
    const [type, value] = assets[assetPath];
    const body = type === 'image/png' ? Uint8Array.from(atob(value), (character) => character.charCodeAt(0)) : value;
    return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache', ...noIndex } });
  }
  if (path === '/travle-plan' || Object.hasOwn(assets, path + '/index.html')) {
    url.pathname += '/';
    return Response.redirect(url, 308);
  }
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp' && request.method === 'POST') return siteMcp(request, env);
    if (url.pathname === '/admin/meal-options' && request.method === 'PUT') {
      return updateMealOptions(request, env);
    }
    if (url.pathname === '/admin/itinerary-verification' && request.method === 'PUT') {
      return updateVerifiedDetails(request, env);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    let response;
    try {
      response = url.pathname.startsWith(dataRoot)
        ? await travelData(env.DB, url.pathname)
        : webAsset(url);
    } catch (error) {
      console.error('Travel data unavailable', error.message);
      response = new Response('Travel data unavailable', { status: 503 });
    }
    return request.method === 'HEAD' ? new Response(null, response) : response;
  },
};

function canEditItinerary(request, env) {
  const [secret, expiresAt] = (env.MEAL_EDIT_ACCESS || '').split(':');
  const supplied = request.headers.get('Authorization') || '';
  const expected = `Bearer ${secret}`;
  const encoder = new TextEncoder();
  return /^[a-f0-9]{64}$/.test(secret) && Number(expiresAt) > Date.now() &&
    supplied.length === expected.length &&
    crypto.subtle.timingSafeEqual(encoder.encode(supplied), encoder.encode(expected));
}

async function updateMealOptions(request, env) {
  if (!canEditItinerary(request, env)) return new Response('Not found', { status: 404 });
  let edit;
  try {
    edit = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  const { slug, date, time, title, expectedNote, note, options, translations } = edit ?? {};
  const validText = (value) => typeof value === 'string' && value.length > 0;
  if (![slug, date, time, title, expectedNote, note].every(validText) || expectedNote === note ||
      !Array.isArray(options) || options.length !== 5 || options.some((option) =>
        !option || ![option.name, option.tip].every(validText) ||
        !Array.isArray(option.pro) || option.pro.length !== 5 || !option.pro.every(validText) ||
        !Array.isArray(option.con) || option.con.length > 5 || !option.con.every(validText))) {
    return new Response('Invalid meal update', { status: 400 });
  }
  const strings = [note, ...options.flatMap((option) => [option.name, option.tip, ...option.pro, ...option.con])];
  if (!['en', 'ja'].every((lang) => strings.every((key) =>
    Object.hasOwn(translations?.[lang] || {}, key) && validText(translations[lang][key])))) {
    return new Response('Incomplete translations', { status: 400 });
  }

  const where = `slug = ? AND time = ? AND title = ? AND note = ? AND card_type = 'choice'
    AND json_array_length(details, '$.options') = 7
    AND item_index IN (SELECT item_index FROM trip_day_plan_items WHERE slug = ? AND date = ?)`;
  const target = [slug, time, title, expectedNote, slug, date];
  const db = env.DB;
  const { results } = await db.prepare(`SELECT item_index, details FROM trip_items WHERE ${where}`)
    .bind(...target).all();
  if (results.length !== 1) return new Response('Meal changed or missing', { status: 409 });
  const { item_index: index, details } = results[0];
  const next = [...options, ...JSON.parse(details).options.slice(-2)];
  const [, item] = await db.batch([
    db.prepare(`UPDATE trip_documents SET body = json_patch(body, json(?))
      WHERE slug = ? AND kind = 'i18n'
      AND EXISTS (SELECT 1 FROM trip_items WHERE item_index = ? AND ${where})`)
      .bind(JSON.stringify({ en: translations.en, ja: translations.ja }), slug, index, ...target),
    db.prepare(`UPDATE trip_items SET note = ?, details = json_set(details, '$.options', json(?))
      WHERE item_index = ? AND ${where}
      AND EXISTS (SELECT 1 FROM trip_documents WHERE slug = ? AND kind = 'i18n')`)
      .bind(note, JSON.stringify(next), index, ...target, slug),
  ]);
  return Response.json({ updated: item.meta.changes }, { status: item.meta.changes === 1 ? 200 : 409 });
}

async function updateVerifiedDetails(request, env) {
  if (!canEditItinerary(request, env)) return new Response('Not found', { status: 404 });
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  const { slug, changes, translations } = payload ?? {};
  const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  // 요금만 바꾸는 요청은 번역 없이 보낼 수 있습니다.
  if (typeof slug !== 'string' || !Array.isArray(changes) || !changes.length || changes.length > 60 ||
      (translations !== undefined && !plainObject(translations)) ||
      ['en', 'ja'].some((lang) => translations?.[lang] !== undefined && !plainObject(translations[lang]))) {
    return new Response('Invalid update', { status: 400 });
  }
  const db = env.DB;
  const { results } = await db.prepare(
    'SELECT item_index, note, cost, details FROM trip_items WHERE slug = ? ORDER BY item_index',
  ).bind(slug).all();
  const edits = new Map();
  for (const { index, path, before, after } of changes) {
    if (!Number.isInteger(index) || !results[index] || typeof path !== 'string' ||
        !/^(note|tip|cost|options\.\d{1,2}\.(tip|con\.\d{1,2}))$/.test(path)) {
      return new Response('Invalid card field', { status: 400 });
    }
    const textField = path !== 'cost';
    if ((textField && (typeof after !== 'string' || !after || !['en', 'ja'].every((lang) =>
      Object.hasOwn(translations?.[lang] ?? {}, after) && typeof translations[lang][after] === 'string'
    ))) || (!textField && (!Number.isSafeInteger(after) || after < 0))) {
      return new Response('Invalid value or missing translation', { status: 400 });
    }
    const original = results[index];
    const edited = edits.get(index) ?? { note: original.note, cost: original.cost, details: JSON.parse(original.details) };
    const keys = path.split('.');
    const field = keys.pop();
    const target = path === 'note' || path === 'cost' ? edited : keys.reduce((object, key) => object?.[key], edited.details);
    if (!target || (target[field] ?? null) !== before) return new Response('Card changed', { status: 409 });
    // 목록 항목은 기존 위치를 바꾸거나 바로 다음 위치에 하나 추가하는 것만 허용합니다.
    if (Array.isArray(target) && Number(field) > target.length) return new Response('Invalid card field', { status: 400 });
    target[field] = after;
    edits.set(index, edited);
  }
  const statements = [...edits].map(([index, edited]) => {
    const original = results[index];
    return db.prepare(`UPDATE trip_items SET note = ?, cost = ?,
      details = CASE WHEN details = ? AND note IS ? AND cost IS ? THEN ? ELSE NULL END
      WHERE slug = ? AND item_index = ?`).bind(
      edited.note, edited.cost, original.details, original.note, original.cost,
      JSON.stringify(edited.details), slug, original.item_index,
    );
  });
  const i18n = await db.prepare("SELECT 1 FROM trip_documents WHERE slug = ? AND kind = 'i18n'").bind(slug).first();
  if (!i18n) return new Response('Missing translation document', { status: 409 });
  statements.push(db.prepare("UPDATE trip_documents SET body = json_patch(body, json(?)) WHERE slug = ? AND kind = 'i18n'")
    .bind(JSON.stringify({ en: translations?.en ?? {}, ja: translations?.ja ?? {} }), slug));
  try {
    await db.batch(statements);
  } catch (error) {
    // 읽은 뒤 다른 수정이 먼저 저장되면 details가 NULL이 되어 NOT NULL 제약으로 전체가 취소됩니다.
    if (/NOT NULL/i.test(error.message)) return new Response('Card changed', { status: 409 });
    console.error('Itinerary update failed', error.message);
    return new Response('Travel data unavailable', { status: 503 });
  }
  return Response.json({ updated: edits.size });
}

const weatherTool = {
  name: 'refresh_weather',
  description: 'Refresh eligible trip forecasts from Open-Meteo, store them in D1, and report the per-trip result. Owner only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const normalizeTool = {
  name: 'normalize_trip_plans',
  description: 'Copy legacy itinerary documents into relational tables once per trip. Owner only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

async function siteMcp(request, env) {
  let message;
  try {
    message = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
  }

  const reply = (result) => Response.json({ jsonrpc: '2.0', id: message?.id ?? null, result });
  const error = (code, detail) => Response.json({
    jsonrpc: '2.0', id: message?.id ?? null, error: { code, message: detail },
  });
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request');
  if (message.method === 'server/discover') {
    return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
  }
  if (message.method === 'tools/list') return reply({ tools: [weatherTool, normalizeTool] });
  if (message.method !== 'tools/call') return error(-32601, 'Method not found');
  const name = message.params?.name;
  if (name !== weatherTool.name && name !== normalizeTool.name) return error(-32602, 'Unknown tool');

  // Sites가 제공하는 확인된 계정만 예보를 갱신할 수 있습니다.
  const caller = request.headers.get('oai-authenticated-user-email')?.toLowerCase();
  if (!request.headers.has('oai-authenticated-user-id') || !env.WEATHER_OWNER_EMAIL ||
      caller !== env.WEATHER_OWNER_EMAIL.toLowerCase()) {
    const text = name === weatherTool.name ? 'Weather updates require the Site owner.' : 'Itinerary migration requires the Site owner.';
    return reply({ isError: true, content: [{ type: 'text', text }] });
  }
  if (name === normalizeTool.name) {
    try {
      const results = await env.DB.batch(itineraryBackfill.map((sql) => env.DB.prepare(sql)));
      return reply({ content: [{ type: 'text', text: JSON.stringify({
        migratedTrips: results.at(-1).meta.changes,
      }) }] });
    } catch (error) {
      console.error('Itinerary migration failed', error.message);
      return reply({ isError: true, content: [{ type: 'text', text: 'The itinerary migration could not be completed.' }] });
    }
  }
  try {
    const results = await refreshTravelWeather(env.DB);
    return reply({
      isError: results.some(({ status }) => status === 'failed' || status === 'rate_limited'),
      content: [{ type: 'text', text: JSON.stringify(results) }],
    });
  } catch (error) {
    console.error('Weather task failed', error.message);
    return reply({ isError: true, content: [{ type: 'text', text: 'The weather update could not be completed.' }] });
  }
}
