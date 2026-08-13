# Rekentrainer

Hoofdrekenoefeningen met een centrale database, zodat je oefengeschiedenis
bewaard blijft en op al je apparaten hetzelfde is.

De app is statisch en draait op GitHub Pages. Er is geen build-stap:
`index.html`, `app.js`, `db.js` en `modes.js` worden rechtstreeks geserveerd.

## Eerste keer

1. Open de pagina en maak een account aan met je e-mailadres en een wachtwoord.
2. Log in. De sessie blijft daarna staan, ook na het sluiten van je browser.
3. Heb je nog oefengeschiedenis in dit apparaat staan van de oude versie, klik
   dan op **Oude data overnemen**. Staat er lokaal niets meer, dan kun je een
   eerder geëxporteerd backupbestand kiezen.

Herhaal stap 2 op je telefoon en je hebt overal hetzelfde beeld.

## Hoe het meet

Elke beantwoorde som gaat als losse regel de database in, met de tijd die je
erover deed. Daaruit wordt per som berekend hoe vaak je hem zag, hoe vaak goed,
je gemiddelde en je recente gemiddelde.

De ranglijst sorteert niet op kale seconden maar op **relatieve traagheid**:
hoeveel langzamer dan jouw eigen normtijd voor dat soort som. Anders zou de
lijst alleen maar bestaan uit sommen met grote getallen.

Losse sommen zie je zelden twee keer — er zijn er duizenden. Daarom worden ze
ook gegroepeerd in **families**: de tafel van 7, optellen met
tientaloverschrijding, aftrekken met lenen, kwadraten per tiental. Daar zit
binnen een week signaal in.

### Spaced repetition op speelbeurten

Herhalingen worden niet in dagen gepland maar in **kansen**: het aantal sommen
dat je in die categorie beantwoordt terwijl deze som getrokken had kunnen
worden. Een drukke dag en een rustige week verstoren elkaar daardoor niet, en
een som veroudert niet terwijl je iets heel anders oefent.

De ladder loopt 12 → 30 → 80 → 200 → 500 → 1200 kansen. Goed en vlot
beantwoord is een trede omhoog; goed maar duidelijk trager dan je eigen
gemiddelde laat de trede staan; fout zet hem terug op nul. Trede 0 komt neer op
"nog binnen dezelfde sessie".

Speeltellers kennen geen vergeten, dus als vangnet zakt alles één trede na
zestig dagen stilte. Dat zit in de view `problem_due` en is daar aan te passen.

### Statistiekenscherm

Vier tabbladen. **Zwakste sommen** heeft hetzelfde instelpaneel als een sessie:
je vinkt categorieën aan en zet bereiken, en de lijst laat precies die sommen
zien. Dezelfde selectie bepaalt waar de knop *Stampen met deze selectie* uit
trekt, zodat je één categorie kunt stampen zonder de rest ertussendoor. Sorteren
kan op zwakste, meest boven je norm, traagst in seconden, vaakst fout of minst
gezien.

**Patronen** toont families, **Tafels** de heatmap, en **Sessies** laat per
sessie zien welke categorieën met welke bereiken aanstonden en hoe lang hij
duurde.

### Presets

Naast de ingebouwde presets kun je je eigen instelling opslaan onder een naam.
Die staan in de database en niet in localStorage, dus een preset die je op je
laptop maakt staat ook op je telefoon. Verwijderen kan met het kruisje naast de
naam.

### Decimalen

Bij oefeningen met een decimaal antwoord bepaal je zelf wanneer iets goed is.
Kies een **vast aantal decimalen** (1 tot 4) en het antwoord telt als het op dat
aantal afgerond klopt: bij 1 : 3 op twee decimalen is 0,33 goed en 0,3 niet.
Omdat de app dan weet wanneer je uitgetypt bent, werkt doorgaan-zodra-het-klopt
ook bij decimalen. Kies je in plaats daarvan een **procentuele marge**, dan lever
je zelf in met enter of de OK-toets. Het gekozen criterium staat tijdens het
oefenen onder het antwoord.

### Datakwaliteit

- Draai je het scherm weg of word je onderbroken, dan staat de klok stil en telt
  die som niet mee in de gemiddelden.
- Sommen boven de dertig seconden worden als uitschieter gemarkeerd.
- In de stand "doorgaan zodra het antwoord klopt" wordt een antwoord met evenveel
  cijfers als het juiste antwoord dat niet klopt als fout geteld. Zonder die
  regel werd in die stand nooit een fout geregistreerd.
- Een stampsessie laat de kansen-klok bewust stilstaan: daar konden alleen je
  zwakke sommen vallen, dus de rest heeft geen kans gehad.

## Database

Supabase-project `LeerServer`. De migraties staan in `supabase/migrations/` en
zijn op volgorde toegepast.

| tabel | wat erin staat |
| --- | --- |
| `sessions` | één rij per sessie |
| `session_modes` | actieve bereiken per categorie plus het aantal beantwoorde sommen; dit is de kansen-klok |
| `attempts` | ruwe log, één rij per beantwoorde som |
| `problem_stats` | aggregaat per som inclusief de SRS-trede |
| `presets` | je eigen opgeslagen instellingen |

Views: `problem_view`, `shape_norm`, `problem_ranked`, `problem_due`,
`problem_board`, `problem_families`, `family_stats`. Alles draait met
`security_invoker`, en elke tabel staat achter row level security die aan
`auth.uid()` hangt. De sleutel in `db.js` is de publishable key en hoort
publiek te zijn.

Een sessie wordt in één transactie weggeschreven met de RPC `sync_session`.
Die is idempotent op `client_id`, dus opnieuw sturen kan geen kwaad. Lukt het
versturen niet, dan blijft de sessie in een wachtrij in `localStorage` staan en
gaat hij mee zodra er weer verbinding is.

## Ontwikkelen

```sh
npm install        # alleen nodig om vendor/supabase.js opnieuw te bouwen
npm test           # controleert de somgeneratoren
npm run vendor     # bundelt supabase-js opnieuw naar vendor/supabase.js
```

`vendor/supabase.js` staat bewust in de repo in plaats van op een CDN: zo laadt
de app zonder derde partij en blijft hij werken zonder bereik.

Een nieuwe oefensoort toevoegen is één blok in `modes.js` met `gen`, `build` en
`range`. De database hoeft daar niet voor te veranderen.
