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

### Herhaling op reactietijd

Alles draait op één continue grootheid: hoe lang je er naar verwachting nu over
zou doen, uitgedrukt in verhouding tot je eigen normtijd voor dat soort som.
De planningsregel is daarmee één zin: **laat een som zien zodra je voorspeld
boven je doeltijd uitkomt.**

Dat is een bewuste keuze tegen de klassieke aanpak in. SM-2 en FSRS sturen op
goed of fout, en bij hoofdrekenen heb je bijna alles goed — dat signaal staat
dus meestal stil, terwijl snelheid juist het leerdoel is. Het model achter
SlimStampen laat zien dat reactietijd een goede maat voor geheugensterkte is,
en die tijd meet de app toch al bij elke som.

Drie dingen houden het model overeind:

- **Een fout antwoord telt als een mislukte ophaling**, met een strafwaarde aan
  de trage kant — niet als de snelle tijd waarin je het foute antwoord typte.
  Zonder die regel zou een som die je snel en zeker fout hebt als sterk gelden,
  en dat zijn juist de gevaarlijkste.
- **De mediaan over je laatste vijf pogingen**, niet het gemiddelde, zodat één
  uitschieter of typefout de schatting nauwelijks verschuift.
- **Shrinkage naar de familie**: hoe minder eigen metingen, hoe zwaarder het
  familiegemiddelde weegt. Dat is tegelijk de mean reversion en de oplossing
  voor sommen die je nog nauwelijks zag. Een typefout op een som die je één keer
  deed wordt daardoor grotendeels genegeerd.

Binnen een sessie blijven speelbeurten de eenheid: een som die je fout deed komt
twaalf sommen later terug. Tussen sessies telt verstreken tijd, want vergeten
hangt af van hoe lang geleden het was en niet van hoeveel andere sommen je deed.
Je werklast blijft beheersbaar doordat de sessie op urgentie gevuld wordt: veel
tijd betekent verder in de lijst komen, weinig tijd betekent alleen het meest
urgente.

Vier constanten sturen het geheel en staan als losse functies in de database, te
wijzigen op één plek: `rt_penalty` (strafwaarde bij een fout), `rt_prior`
(gewicht van de familie), `rt_target` (doeltijd) en `rt_decay` (hoe snel je
wegzakt). Ze staan nu op een beredeneerde schatting en moeten geijkt worden
zodra er een paar weken aan pogingen ligt.

### Datakwaliteit

- Draai je het scherm weg of word je onderbroken, dan staat de klok stil en telt
  die som niet mee in de gemiddelden.
- Sommen boven de dertig seconden worden als uitschieter gemarkeerd.
- In de stand "doorgaan zodra het antwoord klopt" wordt een antwoord met evenveel
  cijfers als het juiste antwoord dat niet klopt als fout geteld. Zonder die
  regel werd in die stand nooit een fout geregistreerd.
- Een stampsessie schrijft geen `session_modes` weg: daar konden alleen je
  zwakke sommen vallen, dus de rest heeft geen echte beurt gehad.

## Database

Supabase-project `LeerServer`. De migraties staan in `supabase/migrations/` en
zijn op volgorde toegepast.

| tabel | wat erin staat |
| --- | --- |
| `sessions` | één rij per sessie |
| `session_modes` | actieve bereiken per categorie plus het aantal beantwoorde sommen; dit is de kansen-klok |
| `attempts` | ruwe log, één rij per beantwoorde som |
| `problem_stats` | aggregaat per som: hoe vaak, hoe vaak goed, opgetelde tijd |
| `presets` | je eigen opgeslagen instellingen |

Views: `attempt_scored`, `shape_norm`, `problem_recent`, `problem_families`,
`family_stats`, `problem_prior` en `problem_board`. Die laatste is wat de app
leest en bevat per som de schatting, de voorspelling en de urgentie. Alles
draait met `security_invoker`, en elke tabel staat achter row level security die
aan `auth.uid()` hangt. De sleutel in `db.js` is de publishable key en hoort
publiek te zijn.

Overgenomen historie uit localStorage heeft geen losse pogingen, alleen een
totaal. `shape_norm` valt daarop terug voor vormen waar nog te weinig echte
pogingen van zijn, en zo'n som telt mee met het aantal keren dat je hem
werkelijk deed, tot maximaal vijf.

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
