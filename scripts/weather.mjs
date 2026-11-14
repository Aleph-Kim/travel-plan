// GitHub Actions에서 매시간 실행해 data/<슬러그>/weather.json을 갱신합니다.
// 예보 조회와 일정 맞바꿈 규칙은 worker/weather.js를 그대로 불러 써서 Sites 버전과 결과가 같습니다.
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('worker/weather.js', root), 'utf8');
const context = vm.createContext({ fetch, AbortSignal, URL, URLSearchParams, setTimeout, console, Date, Math, JSON });
const { readForecast, assignWeatherPlan, dateAfter, forecastDays } = vm.runInContext(
  `${source}\n;({ readForecast, assignWeatherPlan, dateAfter, forecastDays })`, context);

const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const trips = await readJson('data/trips.json');
let failed = false;

for (const { slug } of trips) {
  const plan = await readJson(`data/${slug}/plan.json`);
  const timezone = plan.trip.timezone;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: timezone });
  const start = plan.days[0].date;
  const end = plan.days.at(-1).date;
  const until = [end, dateAfter(today, forecastDays - 1)].sort()[0];
  if (end < today || start > until) {
    console.log(slug, 'outside_forecast_window');
    continue;
  }
  const path = `data/${slug}/weather.json`;
  const previous = await readJson(path).catch(() => ({}));
  try {
    const data = await readForecast(plan.locations, timezone, start, until);
    const weather = { updatedAt: new Date().toISOString(), data, ...assignWeatherPlan(plan, data, previous, today) };
    await writeFile(new URL(path, root), JSON.stringify(weather));
    console.log(slug, 'updated', weather.updatedAt);
  } catch (error) {
    // 실패하면 마지막 정상 예보를 그대로 둡니다.
    failed = true;
    console.error(slug, 'failed', error.message, error.rateLimit ? JSON.stringify(error.rateLimit) : '');
  }
}
if (failed) process.exitCode = 1;
