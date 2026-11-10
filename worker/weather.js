const forecastDays = 16;
const hourMs = 60 * 60 * 1000;
const weatherClaimMs = 60_000;
const forecastTimeoutMs = 10_000;
const concurrentRetryDelayMs = 2_000;
const maxInlineRetryDelayMs = 5_000;
const forecastUrl = 'https://api.open-meteo.com/v1/forecast';
const hourlyFields = ['temperature_2m', 'apparent_temperature', 'precipitation_probability',
  'precipitation', 'weather_code', 'wind_speed_10m', 'relative_humidity_2m'];
const dailyFields = {
  code: 'weather_code', max: 'temperature_2m_max', min: 'temperature_2m_min',
  pop: 'precipitation_probability_max', rain: 'precipitation_sum', wind: 'wind_speed_10m_max',
  uv: 'uv_index_max', sunrise: 'sunrise', sunset: 'sunset',
};

function dateAfter(date, days) {
  return new Date(Date.parse(date) + days * 24 * hourMs).toISOString().slice(0, 10);
}

function retryAfterTime(header, now) {
  if (!header) return null;
  const time = /^\d+$/.test(header) ? now + Number(header) * 1000 : Date.parse(header);
  return Number.isNaN(new Date(time).getTime()) ? null : Math.max(time, now);
}

async function requestForecast(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(forecastTimeoutMs) });
  if (response.ok) return response.json();

  const error = new Error(`Open-Meteo HTTP ${response.status}`);
  error.status = response.status;
  if (response.status === 429) {
    const body = await response.json().catch(() => null);
    const retryAfter = response.headers.get('retry-after');
    error.rateLimit = {
      reason: typeof body?.reason === 'string' ? body.reason.slice(0, 240) : null,
      retryAfter,
      rayId: response.headers.get('cf-ray'),
    };
    error.retryAt = retryAfterTime(retryAfter, Date.now());
  } else {
    await response.body?.cancel().catch(() => {});
  }
  throw error;
}

async function readForecast(locations, timezone, start, end) {
  const entries = Object.entries(locations);
  const url = new URL(forecastUrl);
  url.search = new URLSearchParams({
    latitude: entries.map(([, location]) => location.lat).join(','),
    longitude: entries.map(([, location]) => location.lon).join(','),
    timezone, start_date: start, end_date: end, wind_speed_unit: 'ms',
    daily: Object.values(dailyFields).join(','), hourly: hourlyFields.join(','),
  });
  let forecast;
  try {
    forecast = await requestForecast(url);
  } catch (error) {
    const delay = Math.max(concurrentRetryDelayMs, (error.retryAt ?? 0) - Date.now());
    if (error.rateLimit?.reason !== 'Too many concurrent requests' || delay > maxInlineRetryDelayMs) throw error;
    await new Promise((resolve) => setTimeout(resolve, delay));
    forecast = await requestForecast(url);
  }
  const rows = Array.isArray(forecast) ? forecast : [forecast];
  if (rows.length !== entries.length) throw new Error('Open-Meteo returned an incomplete location list');
  return Object.fromEntries(entries.map(([key], index) => [key, formatForecast(rows[index])]));
}

function formatForecast({ daily, hourly }) {
  const valid = (rows, fields) => Array.isArray(rows?.time) && rows.time.length > 0 &&
    fields.every((field) => Array.isArray(rows[field]) && rows[field].length === rows.time.length);
  if (!valid(daily, Object.values(dailyFields)) || !valid(hourly, hourlyFields)) {
    throw new Error('Open-Meteo returned an incomplete forecast');
  }

  const hoursByDay = new Map();
  for (const [index, time] of hourly.time.entries()) {
    const day = time.slice(0, 10);
    if (!hoursByDay.has(day)) hoursByDay.set(day, []);
    hoursByDay.get(day).push([Number(time.slice(11, 13)), ...hourlyFields.map((field) => hourly[field][index])]);
  }
  return Object.fromEntries(daily.time.map((day, index) => {
    const values = Object.fromEntries(Object.entries(dailyFields).map(([key, field]) => {
      const value = daily[field][index];
      return [key, field === 'sunrise' || field === 'sunset' ? value?.slice(11, 16) ?? null : value];
    }));
    return [day, { ...values, hours: hoursByDay.get(day) ?? [] }];
  }));
}

function assignWeatherPlan(plan, data, previous, today) {
  const days = new Map(plan.days.map((day) => [day.date, day]));
  const defaults = Object.fromEntries(plan.days.map((day) => [day.date, day.default]));
  const locked = {};
  const { base, weights = {} } = plan.trip.swap ?? {};
  const hasPlan = (date, key) => Object.hasOwn(days.get(date).plans, key);
  const rainy = (date, key) => {
    const location = days.get(date).plans[key].weather;
    const pop = data[location]?.[date]?.pop;
    return pop != null && pop >= plan.rainThreshold;
  };

  // 당일과 지난 날짜의 일정과 비 판정은 기존에 확정한 값을 유지합니다.
  for (const [date, key] of Object.entries(defaults)) {
    if (date <= today) {
      const previousKey = previous.plan?.[date];
      locked[date] = hasPlan(date, previousKey) ? previousKey : key;
    }
  }

  const candidates = [defaults];
  for (const [date, key] of Object.entries(defaults)) {
    if (!Object.hasOwn(weights, key)) continue;
    for (const [baseDate, baseKey] of Object.entries(defaults)) {
      if (baseKey === base && hasPlan(date, base) && hasPlan(baseDate, key)) {
        candidates.push({ ...defaults, [date]: base, [baseDate]: key });
      }
    }
  }
  const cost = (assignment) => Object.entries(assignment).reduce((total, [date, key]) =>
    Object.hasOwn(locked, date) ? total : total +
      (weights[key] ?? 0) * Number(rainy(date, key)) + (key === defaults[date] ? 0 : 0.5), 0);
  let selected = null;
  let lowest = Infinity;
  for (const candidate of candidates) {
    if (!Object.entries(locked).every(([date, key]) => candidate[date] === key)) continue;
    const score = cost(candidate);
    if (score < lowest) {
      selected = candidate;
      lowest = score;
    }
  }
  const assignment = selected ?? { ...defaults, ...locked };
  const rain = Object.fromEntries(Object.entries(assignment).map(([date, key]) => [
    date, Object.hasOwn(locked, date) && Object.hasOwn(previous.rain ?? {}, date)
      ? previous.rain[date] : rainy(date, key),
  ]));
  return { plan: assignment, rain };
}

async function weatherClaimStatus(db, slug, hourStart) {
  const state = await db.prepare(`
    SELECT t.weather_checked_at, t.weather_retry_at, json_extract(w.body, '$.updatedAt') AS updated_at
    FROM trips t
    LEFT JOIN trip_documents w ON w.slug = t.slug AND w.kind = 'weather'
    WHERE t.slug = ?
  `).bind(slug).first();
  if (!state) return { slug, status: 'superseded' };
  const updatedAt = state.updated_at ?? null;
  if (Date.parse(updatedAt) >= hourStart) return { slug, status: 'already_checked', updatedAt };
  const now = Date.now();
  if (state.weather_retry_at > now) {
    return { slug, status: 'rate_limited', updatedAt, retryAt: new Date(state.weather_retry_at).toISOString() };
  }
  const status = state.weather_checked_at > now - weatherClaimMs ? 'in_progress' : 'failed';
  return { slug, status, updatedAt };
}

async function updateWeatherTrip(db, trip) {
  const now = Date.now();
  const today = new Date(now).toLocaleDateString('sv-SE', { timeZone: trip.timezone });
  const plan = JSON.parse(trip.plan_body);
  const start = plan.days[0].date;
  const end = plan.days.at(-1).date;
  const until = [end, dateAfter(today, forecastDays - 1)].sort()[0];
  if (end < today || start > until) return { slug: trip.slug, status: 'outside_forecast_window' };

  const hourStart = Math.floor(now / hourMs) * hourMs;
  const claim = await db.prepare(`
    UPDATE trips SET weather_checked_at = ?1
    WHERE slug = ?2 AND weather_checked_at <= ?3 AND weather_retry_at <= ?1
      AND NOT EXISTS (
        SELECT 1 FROM trip_documents
        WHERE slug = ?2 AND kind = 'weather'
          AND julianday(json_extract(body, '$.updatedAt')) >= julianday(?4)
      )
    RETURNING (SELECT body FROM trip_documents WHERE slug = trips.slug AND kind = 'weather') AS weather_body
  `).bind(now, trip.slug, now - weatherClaimMs, new Date(hourStart).toISOString()).first();
  if (!claim) return weatherClaimStatus(db, trip.slug, hourStart);

  const release = (retryAt = 0) => db.prepare(`
    UPDATE trips SET weather_checked_at = 0, weather_retry_at = ?
    WHERE slug = ? AND weather_checked_at = ?
  `).bind(retryAt, trip.slug, now);
  const previous = JSON.parse(claim.weather_body ?? '{}') ?? {};

  try {
    const data = await readForecast(plan.locations, trip.timezone, start, until);
    const updatedAt = new Date().toISOString();
    const weather = { updatedAt, data, ...assignWeatherPlan(plan, data, previous, today) };
    const save = db.prepare(`
      INSERT INTO trip_documents (slug, kind, body)
      SELECT slug, 'weather', ? FROM trips WHERE slug = ? AND weather_checked_at = ?
      ON CONFLICT(slug, kind) DO UPDATE SET body = excluded.body
      WHERE COALESCE(julianday(json_extract(trip_documents.body, '$.updatedAt')), 0)
        < julianday(json_extract(excluded.body, '$.updatedAt'))
      RETURNING json_extract(body, '$.updatedAt') AS updated_at
    `).bind(JSON.stringify(weather), trip.slug, now);
    const [saved] = await db.batch([save, release()]);
    if (!saved.results.length) return { slug: trip.slug, status: 'superseded' };
    console.info('Weather updated', JSON.stringify({ slug: trip.slug, updatedAt }));
    return { slug: trip.slug, status: 'updated', updatedAt };
  } catch (error) {
    const updatedAt = previous.updatedAt ?? null;
    if (error.status === 429) {
      const retryAt = error.retryAt ?? (Math.floor(Date.now() / hourMs) + 1) * hourMs;
      console.error('Open-Meteo rate limited', JSON.stringify({ slug: trip.slug, ...error.rateLimit }));
      await release(retryAt).run();
      return { slug: trip.slug, status: 'rate_limited', updatedAt, retryAt: new Date(retryAt).toISOString() };
    }
    await release().run();
    console.error('Weather update failed', trip.slug, error.message);
    return { slug: trip.slug, status: 'failed', updatedAt };
  }
}

async function refreshTravelWeather(db) {
  const { results: trips } = await db.prepare(`
    SELECT t.slug, t.timezone, p.body AS plan_body
    FROM trips t
    JOIN trip_plan_documents p ON p.slug = t.slug
    ORDER BY t.starts_on, t.slug
  `).all();
  const results = [];
  for (const trip of trips) {
    try {
      results.push(await updateWeatherTrip(db, trip));
    } catch (error) {
      console.error('Weather update failed', trip.slug, error.message);
      results.push({ slug: trip.slug, status: 'failed' });
    }
  }
  return results;
}
