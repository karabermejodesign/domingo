// Playwright run against a mock API: serves public/cook/index.html at /cook, fakes GoTrue + /api/*.
// Usage: node scripts/e2e-mock.mjs   (from the repo root; needs playwright + chromium available)
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs'

const html = await readFile(new URL('../public/cook/index.html', import.meta.url), 'utf8')
const seed = JSON.parse(await readFile(new URL('../src/data/seed-week.json', import.meta.url), 'utf8'))
const db = { state: {}, ratings: [], patches: 0, settings: {}, builds: 0, buildBody: null }
const TOKEN = 'tok-abc'

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)) })
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  const authed = (req.headers.authorization || '') === 'Bearer ' + TOKEN
  if (url.pathname === '/cook') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html) }
  if (url.pathname === '/api/health') return json(200, { ok: true, hasEnv: true })
  if (url.pathname === '/api/config') return json(200, { supabaseUrl: 'http://127.0.0.1:4310', anonKey: 'anon' })
  if (url.pathname === '/auth/v1/token') {
    const b = JSON.parse(body || '{}')
    if (url.searchParams.get('grant_type') === 'password') {
      if (b.email === 'kara@example.com' && b.password === 'pw') return json(200, { access_token: TOKEN, refresh_token: 'r', expires_in: 3600, user: { id: 'u1' } })
      return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' })
    }
    return json(200, { access_token: TOKEN, refresh_token: 'r', expires_in: 3600, user: { id: 'u1' } })
  }
  if (url.pathname === '/auth/v1/user') return authed ? json(200, { id: 'u1' }) : json(401, {})
  if (!authed) return json(401, { error: 'Sign in to use this' })
  if (url.pathname === '/api/week' && req.method === 'GET') return json(200, { weekId: seed.week.id, label: seed.week.label, plan: db.plan || seed, state: db.state, settings: db.settings })
  if (url.pathname === '/api/week' && req.method === 'PATCH') { const b = JSON.parse(body); Object.assign(db.state, b.state); db.patches++; return json(200, { ok: true }) }
  if (url.pathname === '/api/rate' && req.method === 'GET') return json(200, { ratings: db.ratings })
  if (url.pathname === '/api/pantry-photo' && req.method === 'POST') { const b = JSON.parse(body); db.photo = { bytes: b.image.length, known: b.known }; return json(200, { items: [{ name: 'Eggs', match: 'Eggs', note: 'about 6' }, { name: 'Half a jar of hummus', match: null }, { name: 'Rice', match: 'Rice' }] }) }
  if (url.pathname === '/api/settings' && req.method === 'PATCH') { const b = JSON.parse(body); if (b.budget === null) delete db.settings.budget; else if (Number.isInteger(b.budget) && b.budget >= 20000) db.settings.budget = { max: b.budget }; else return json(400, { error: 'budget must be a whole number between 20000 and 2000000 CLP' }); return json(200, { ok: true, settings: db.settings }) }
  if (url.pathname === '/api/prices' && req.method === 'POST') {
    db.priceCalls = (db.priceCalls || 0) + 1
    const plan = JSON.parse(JSON.stringify(db.plan || seed)); const l = plan.groceries.lider[0]; const before = seed.groceries.lider[0].p
    l.p = 6990; l.unit = 6990; l.prev = before; l.promo = 'Rebaja'; l.deal = true; l.pUrl = 'https://super.lider.cl/ip/pollo-entero-seara/123'
    plan.week.pricesCheckedAt = '2026-10-31T15:00:00.000Z'; plan.week.pricesChecked = 'Prices re-checked (mock)'; db.plan = plan
    return json(200, { plan, checked: 17, matched: 16, changed: [{ t: l.t, from: before, to: 6990 }] })
  }
  if (url.pathname === '/api/build' && req.method === 'POST') { const b = JSON.parse(body); db.builds++; db.buildBody = b
    const menu = JSON.parse(JSON.stringify(db.state.menu || seed.menu)); menu[0].d = 3
    const build = { skip: ['Brócoli congelado 500 g'], adjust: [{ t: 'Huevos Ovofoods mediano, 30 un', q: '1, you have some', p: 3600 }], note: 'Monday dinner is now lentejas to use the lentils; dropped the broccoli you already have.', hash: b.hash, at: new Date().toISOString() }
    Object.assign(db.state, { menu, build }); return json(200, { menu, build }) }
  if (url.pathname === '/api/rate' && req.method === 'POST') { db.ratings.push(JSON.parse(body)); return json(200, { ok: true }) }
  json(404, { error: 'nope' })
})
await new Promise(r => server.listen(4310, r))

let n = 0, failed = 0
const t = (name, ok) => { n++; if (!ok) { failed++; console.log('  FAIL', name) } else console.log('  ok  ', name) }
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const click = async sel => { const l = page.locator(sel).filter({ visible: true }).first(); await page.evaluate(() => { const s = document.getElementById('snack'); if (s) s.hidden = true }); await l.evaluate(el => el.scrollIntoView({ block: 'center' })); await l.click() }
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|status of 400/.test(m.text())) errors.push(m.text()) })  // fonts are blocked in the sandbox; the 400 is the deliberate wrong password

await page.goto('http://127.0.0.1:4310/cook?today=2026-10-31')  // the planning Saturday for 2026-W45
await page.waitForSelector('#s-login:not([hidden])')
t('boot shows login when signed out', await page.isVisible('#loginForm'))
t('nav hidden on login', !(await page.isVisible('nav.nav')))
await page.fill('#email', 'kara@example.com'); await page.fill('#password', 'wrong'); await click('#loginBtn')
await page.waitForSelector('#loginErr:not([hidden])')
t('wrong password shows error', (await page.textContent('#loginErr')).includes('Wrong'))
await page.fill('#password', 'pw'); await click('#loginBtn')
await page.waitForSelector('#s-home:not([hidden])')
t('home renders after sign-in', (await page.textContent('#weekLbl')).includes('Week of'))
t('session stored under cook_sess', !!(await page.evaluate(() => localStorage.getItem('cook_sess'))))
t('six steps listed', (await page.$$('#homeSteps .li')).length === 6)
t('sign-out button visible', await page.isVisible('#outBtn'))

await click('#startBtn'); await page.waitForSelector('#s-pantry:not([hidden])')
t('start goes to pantry', (await page.textContent('#title')) === 'Pantry check')
t('step label 1 of 6', (await page.textContent('#stepLbl')) === '1 of 6')
const pantryRows = (await page.$$('#pantryList .li')).length
t('pantry rows from plan', pantryRows === seed.pantry.length)
t('eggs toggle starts on', await page.isChecked('input[data-pk="eggs"]'))
await click('input[data-pk="eggs"]')
await page.waitForTimeout(900)
t('pantry toggle PATCHed to server', db.patches >= 1 && db.state.pantry && db.state.pantry.eggs === false)
await page.fill('#addItem', 'half a jar of hummus'); await page.press('#addItem', 'Enter')
await page.waitForTimeout(900)
t('free-text pantry item added and saved', (db.state.extraPantry || []).includes('half a jar of hummus'))
t('staples shown as chips', (await page.$$('#stapleChips .chip')).length === seed.staples.length + 1)
// pantry photo: feed a tiny PNG through the file input, expect the mock's three items, keep two
await page.setInputFiles('#photoInput', { name: 'fridge.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') })
await page.waitForSelector('#photoList:not([hidden])')
t('photo posted downscaled jpeg with known names', db.photo && db.photo.bytes > 100 && db.photo.known.includes('Eggs'))
t('photo result lists three items ticked', (await page.$$('#photoList .cb.on')).length === 3)
await click('#photoList [data-pi="2"]')
await click('#photoKeep'); await page.waitForTimeout(900)
t('photo keep: eggs toggled back on, hummus added as free text, rice (unticked) ignored', db.state.pantry.eggs === true && (db.state.extraPantry || []).some(x => x.startsWith('Half a jar of hummus')) && !(db.state.extraPantry || []).includes('Rice'))
t('photo list cleared after keep', !(await page.isVisible('#photoList')))
await click('input[data-pk="eggs"]'); await page.waitForTimeout(900)
t('eggs toggled off again for the list assertions', db.state.pantry.eggs === false)

await click('[data-go="deals"]'); await page.waitForSelector('#s-deals:not([hidden])')
const groups = await page.$$eval('#dealGroups .eyebrow', els => els.map(e => e.textContent))
t('deals: LATAM Pass first, then Lider, then Jumbo', groups[0].includes('LATAM') && groups[1] === 'Lider' && groups[2] === 'Jumbo')
await click('input[data-deal="lider:3"]'); await page.waitForTimeout(900)
t('deal toggle saved', db.state.deals && db.state.deals['lider:3'] === true)

// Build menu: the button rebuilds through /api/build, then only rebuilds again when inputs change
await click('#buildBtn'); await page.waitForSelector('#s-menu:not([hidden])')
await page.waitForFunction(() => /lentejas/.test(document.querySelector('#buildRow').textContent))
t('Build menu calls the planner once with pantry, free text and deals', db.builds === 1 && db.buildBody.pantry && db.buildBody.extraPantry.length === 2 && db.buildBody.deals['lider:3'] === true && typeof db.buildBody.hash === 'string')
t('menu card shows what changed', (await page.textContent('#buildRow')).includes('dropped the broccoli'))
t('rebuilt menu applied (Monday dinner now lentejas)', (await page.textContent('#days details:first-child')).includes('Lentejas'))
t('seven days rendered', (await page.$$('#days details')).length === 7)
await click('[data-go="deals"]'); await page.waitForSelector('#s-deals:not([hidden])')
await click('#buildBtn'); await page.waitForSelector('#s-menu:not([hidden])'); await page.waitForTimeout(300)
t('Build menu with nothing changed does not call the planner again', db.builds === 1)
await click('[data-nav="home"]'); await page.waitForSelector('#s-home:not([hidden])'); await click('#homeSteps [data-go="pantry"]'); await page.waitForSelector('#s-pantry:not([hidden])')
await click('input[data-pk="pb"]'); await page.waitForTimeout(300)
await click('[data-nav="menu"]'); await page.waitForSelector('#s-menu:not([hidden])')
t('pantry change marks the build stale', (await page.textContent('#buildRow')).includes('changed since') && (await page.textContent('#buildRow')).includes('Rebuild menu'))
await click('[data-nav="home"]'); await page.waitForSelector('#s-home:not([hidden])'); await click('#homeSteps [data-go="pantry"]'); await page.waitForSelector('#s-pantry:not([hidden])')
await click('input[data-pk="pb"]'); await page.waitForTimeout(900)
await click('[data-nav="menu"]'); await page.waitForSelector('#s-menu:not([hidden])')
t('undoing the change makes it fresh again', !(await page.textContent('#buildRow')).includes('changed since'))
t('menu on target badge', (await page.textContent('#menuOk')) === 'On target')
await click('[data-swap="0:d"]'); await page.waitForSelector('#sheet:not([hidden])')
t('swap sheet lists dinner pool', (await page.$$('#sheetOpts .opt')).length === seed.meals.d.length)
await click('#sheetOpts [data-pick="6"]'); await page.waitForTimeout(900)
t('swap saved to server', db.state.menu && db.state.menu[0].d === 6)
t('swap reflected in UI', (await page.textContent('#days details:first-child')).includes('congrio'))
await click('[data-rate="0:d:1"]'); await page.waitForTimeout(300)
t('rating POSTed', db.ratings.length === 1 && db.ratings[0].rating === 1 && db.ratings[0].slot === 'd')
t('rating chip highlighted', await page.$eval('[data-rate="0:d:1"]', el => el.classList.contains('on')))

await click('[data-go="list"]'); await page.waitForSelector('#s-list:not([hidden])')
const storeHeads = await page.$$eval('#storeLists .eyebrow', els => els.map(e => e.textContent))
t('store orders with days (Jumbo hidden: its only item is in the freezer)', storeHeads.length === 3 && storeHeads.some(h => h.includes('Aquality · Tuesday, in 3 days')) && storeHeads.some(h => h.includes('Juan Esparraguito · Wednesday, in 4 days')))
t('Lider order is due today on the planning Saturday', storeHeads.some(h => h.includes('Lider · Saturday')) && (await page.textContent('#storeLists')).includes('Order today'))
t('eggs now on the list (pantry off)', (await page.textContent('#storeLists')).includes('Huevos'))
t('planner-skipped broccoli moved to Already have', !(await page.textContent('#storeLists')).includes('Brócoli') && (await page.textContent('#haveList')).includes('Brócoli'))
t('planner-trimmed eggs line shows new quantity and price', (await page.textContent('#storeLists')).includes('you have some') && (await page.textContent('#storeLists')).includes('3.600') && (await page.textContent('#storeLists')).includes('trimmed'))
t('peanut butter under Already have', (await page.textContent('#haveList')).includes('Mantequilla'))
const links = await page.$$eval('#storeLists a', as => as.map(a => a.href))
t('every grocery line has a store link', links.length > 0 && links.every(h => /^https:\/\/(super\.lider\.cl|www\.jumbo\.cl|www\.aqualitysoluciones\.cl|juanesparraguito\.com)/.test(h)))
t('budget badge in range', ['In range'].includes(await page.textContent('#budgetBadge')) || (await page.textContent('#budgetBadge')).includes('under'))
// Budget setting: tap the "of $X" on the list, save a number, see it everywhere; then back to the plan default
t('list shows the plan default budget', (await page.textContent('#budgetOf')).includes('130.000'))
await click('#budgetOf'); await page.waitForSelector('#budgetForm')
t('budget sheet opens with the current number', (await page.inputValue('#budgetIn')) === '130.000')
await page.fill('#budgetIn', '1000'); await click('#budgetSave'); await page.waitForSelector('#budgetErr:not([hidden])')
t('too-small budget rejected client-side', (await page.textContent('#budgetErr')).includes('20.000'))
await page.fill('#budgetIn', '80000'); await click('#budgetSave'); await page.waitForTimeout(600)
t('budget saved to server', db.settings.budget && db.settings.budget.max === 80000)
t('list card uses the new budget', (await page.textContent('#budgetOf')).includes('80.000'))
t('over budget now flagged', (await page.textContent('#budgetBadge')) === 'Over budget')
await click('[data-nav="home"]'); await page.waitForSelector('#s-home:not([hidden])')
t('home badge shows your budget', (await page.textContent('#budgetBtn')).includes('Budget 80k') && (await page.textContent('#budgetBtn')).includes('yours'))
await click('#budgetBtn'); await page.waitForSelector('#budgetDefault')
await click('#budgetDefault'); await page.waitForTimeout(600)
t('plan default restored', !db.settings.budget && (await page.textContent('#budgetBtn')).includes('110k to 130k'))
await page.reload(); await page.waitForSelector('#s-home:not([hidden])')
await click('#budgetBtn'); await page.waitForSelector('#budgetForm'); await page.fill('#budgetIn', '120000'); await click('#budgetSave'); await page.waitForTimeout(600)
await page.reload(); await page.waitForSelector('#s-home:not([hidden])')
t('budget survives a reload (comes back from /api/week)', (await page.textContent('#budgetBtn')).includes('Budget 120k'))
await click('[data-nav="list"]'); await page.waitForSelector('#s-list:not([hidden])')
await click('[data-buy="Pollo Entero Seara 2,2 kg"]'); await page.waitForTimeout(900)
t('bought tick saved', db.state.bought && db.state.bought['Pollo Entero Seara 2,2 kg'] === true)

await click('[data-go="cook"]'); await page.waitForSelector('#s-cook:not([hidden])')
t('timeline steps rendered', (await page.$$('#timeline .tli')).length === seed.cook.timeline.length)
t('hummus step mentions tahini', (await page.textContent('#timeline')).includes('tahini'))
t('no grams or ml in cook plan', !/\b\d+\s?(g|ml)\b/.test(await page.textContent('#timeline')))
t('tool badges present', (await page.$$('#timeline .tool')).length >= 8)

await click('[data-go="send"]'); await page.waitForSelector('#s-send:not([hidden])')
const preview = await page.textContent('#preview')
t('preview groups by store with order day', preview.includes('AQUALITY, order Tuesday') && preview.includes('JUAN ESPARRAGUITO, order Wednesday'))
t('preview includes product links', preview.includes('https://super.lider.cl/'))
t('preview carries the custom budget', preview.includes('(budget 120k)'))
t('preview lists Already have incl. free-text pantry', preview.includes('Already have: Mantequilla') && preview.includes('Half a jar of hummus'))
await click('#sendBtn'); await page.waitForTimeout(300)
t('WhatsApp without number asks for it', (await page.textContent('#snackTxt')).includes('number'))
await click('[data-ch="copy"]'); await click('#sendBtn'); await page.waitForTimeout(900)
t('copy marks week as sent', db.state.sent === true && await page.isVisible('#doneCard'))

await page.reload(); await page.waitForSelector('#s-send:not([hidden]), #s-home:not([hidden])')
t('reload keeps session and lands on saved step', (await page.textContent('#title')) === 'Send')

// Date awareness: the same plan, viewed on other days
await page.goto('http://127.0.0.1:4310/cook?today=2026-11-01'); await page.waitForSelector('#s-send:not([hidden]), #s-home:not([hidden])')
await click('[data-nav="home"]'); await page.waitForSelector('#s-home:not([hidden])')
t('Sunday with no order placed: home says so', (await page.textContent('#weekLead')).includes("hasn't gone in"))
await click('[data-nav="list"]'); await page.waitForSelector('#s-list:not([hidden])')
t('Lider header flips to late', (await page.textContent('#storeLists')).includes('Lider · was Saturday') && (await page.textContent('#storeLists')).includes('1 day late'))
await click('[data-nav="cook"]'); await page.waitForSelector('#s-cook:not([hidden])')
t('cook screen waits for groceries', (await page.textContent('#cookTitle')).includes('once the groceries land') && (await page.textContent('#cookWhen')).includes('Sun 1 Nov'))
await click('[data-go="send"]'); await page.waitForSelector('#s-send:not([hidden])')
t('message says order today, was Saturday', (await page.textContent('#preview')).includes('LIDER, order today (was Saturday)'))
await click('[data-nav="list"]'); await page.waitForSelector('#s-list:not([hidden])')
await click('[data-mark="lider"]'); await page.waitForTimeout(900)
t('Mark ordered ticks every Lider line and saves', (await page.textContent('#storeLists')).includes('Ordered') && Object.values(db.state.bought).filter(Boolean).length >= 10)
await click('[data-nav="home"]'); await page.waitForSelector('#s-home:not([hidden])')
t('Sunday with groceries in: time to cook', (await page.textContent('#weekLead')).includes('time to batch cook'))
await page.goto('http://127.0.0.1:4310/cook?today=2026-11-03'); await page.waitForSelector('#s-send:not([hidden]), #s-home:not([hidden])')
await click('[data-nav="home"]'); await page.waitForSelector('#s-home:not([hidden])')
t('mid-week home shows day of week and tonight\'s dinner', /Tuesday, day 2 of 7\. Tonight: /.test(await page.textContent('#weekLead')))
await click('[data-nav="menu"]'); await page.waitForSelector('#s-menu:not([hidden])')
t('menu opens on today with a Today badge', await page.$eval('#days details:nth-child(2)', d => d.open && d.textContent.includes('Today')) && !(await page.$eval('#days details:first-child', d => d.open)))
t('menu days carry dates', (await page.textContent('#days details:first-child .dn')).includes('2'))
await click('[data-nav="list"]'); await page.waitForSelector('#s-list:not([hidden])')
t('Lider stays Ordered mid-week, Aquality is due today', (await page.textContent('#storeLists')).includes('Ordered') && (await page.textContent('#storeLists')).includes('Aquality · Tuesday'))

// Price refresh: button, stamp, product link, and the auto-run when an order is due.
// The late-Sunday block above already triggered one automatic check (Lider overdue, no stamp yet).
t('overdue order triggered one automatic price check', db.priceCalls === 1)
await page.goto('http://127.0.0.1:4310/cook?today=2026-10-29'); await page.waitForSelector('#s-send:not([hidden]), #s-home:not([hidden])')
await click('[data-nav="list"]'); await page.waitForSelector('#s-list:not([hidden])'); await page.waitForTimeout(400)
t('no automatic check when nothing is due', db.priceCalls === 1 && (await page.textContent('#priceStamp')).includes('Prices checked Sat 31 Oct'))
t('line shows new price, promo and was-price', (await page.textContent('#storeLists')).includes('$6.990') && (await page.textContent('#storeLists')).includes('Rebaja') && (await page.textContent('#storeLists')).includes('was $7.190'))
t('line links to the product page once known', (await page.$$eval('#storeLists a', as => as.map(a => a.href))).includes('https://super.lider.cl/ip/pollo-entero-seara/123'))
await click('#refreshBtn'); await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled)
t('Refresh prices button calls the route', db.priceCalls === 2)
t('snack reports the change', (await page.textContent('#snackTxt')).includes('1 price changed'))
await page.goto('http://127.0.0.1:4310/cook?today=2026-11-01'); await page.waitForSelector('#s-send:not([hidden]), #s-home:not([hidden])'); await page.waitForTimeout(500)
t('automatic check runs once per app open', db.priceCalls === 2)
await click('[data-nav="list"]'); await page.waitForSelector('#s-list:not([hidden])')
t('stale stamp warns when an order is pending', (await page.textContent('#priceStamp')).includes('may have moved'))
await page.evaluate(() => sessionStorage.clear()); await page.reload(); await page.waitForSelector('#s-list:not([hidden]), #s-send:not([hidden]), #s-home:not([hidden])')
await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled); await page.waitForTimeout(200)
t('next app open with a pending order checks again', db.priceCalls === 3)
await page.goto('http://127.0.0.1:4310/cook'); await page.waitForSelector('#s-send:not([hidden]), #s-home:not([hidden])')
await click('#outBtn'); await page.waitForSelector('#s-login:not([hidden])')
t('sign out returns to login', !(await page.evaluate(() => localStorage.getItem('cook_sess'))))

t('no page errors', errors.length === 0)
if (errors.length) console.log(errors)
await browser.close(); server.close()
console.log(`\n${n - failed}/${n} assertions passed`)
process.exit(failed ? 1 : 0)
