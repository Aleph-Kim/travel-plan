#!/usr/bin/env bash
# GitHub Pages에 올릴 정적 사이트를 _site/에 만듭니다.
# 주소 구조는 Sites 버전과 같습니다: /, /travle-plan/, /travle-plan/<슬러그>/, /travle-plan/data/...
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf _site
mkdir -p _site/travle-plan/data
cp -R web/travle-plan/. _site/travle-plan/

# 대시보드는 루트와 /travle-plan/ 두 곳에 둡니다. base를 상대 경로로 바꿔
# 사용자 도메인(travel.aleph.kr)과 github.io/travel-plan/ 하위 경로에서 모두 동작하게 합니다.
grep -q '<base href="/travle-plan/">' web/index.html
sed 's|<base href="/travle-plan/">|<base href="travle-plan/">|' web/index.html > _site/index.html
sed 's|<base href="/travle-plan/">|<base href="./">|' web/index.html > _site/travle-plan/index.html

cp data/trips.json _site/travle-plan/data/
for dir in data/*/; do
  slug=$(basename "$dir")
  [ -f "$dir/plan.json" ] || continue
  mkdir -p "_site/travle-plan/data/$slug"
  for kind in plan i18n weather; do
    [ -f "$dir/$kind.json" ] && cp "$dir/$kind.json" "_site/travle-plan/data/$slug/"
  done
done
touch _site/.nojekyll
echo "built _site"
