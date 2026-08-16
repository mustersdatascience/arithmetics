# Mentat

Hoofdrekenoefeningen met een centrale database, zodat je oefengeschiedenis
bewaard blijft en op al je apparaten hetzelfde is.

De app is statisch en draait op GitHub Pages. Er is geen build-stap:
`index.html`, `app.js`, `db.js` en `modes.js` worden rechtstreeks geserveerd.

De interface draagt de kleuren van huis Atreides: groen en zwart met brons in
het donker, perkament en zand met dezelfde groen en brons in het licht. Alles
loopt op CSS-variabelen, dus een ander palet is een kwestie van de tokens
bovenaan `index.html` vervangen.

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

### Een sessie blijft afwisselend

Hoeveel er ook openstaat, hoogstens een derde van een sessie bestaat uit
herhalingen. Staat er weinig dringend open, dan zakt dat aandeel vanzelf en komt
er meer nieuw materiaal langs. Andersom loopt het nooit op: een sessie mag niet
in stampen veranderen.

De plaatsing is bovendien willekeurig in plaats van elke zoveelste som, en er
komen nooit twee herhalingen achter elkaar. Bij een bord waar alles openstond
kwam dat in een test uit op 31 procent, verspreid door de sessie.

Eén op de tien sommen wordt volledig willekeurig getrokken, zonder weging. De
planner kiest anders zelf wat je ziet en leert daarna alleen van wat hij koos:
een som waarvan hij ten onrechte denkt dat je die kent zou dan nooit langskomen
om dat te weerleggen.

### Parameters die zichzelf ijken

Vier waarden sturen het model. Twee ervan stelt de app zelf bij op je eigen
historie, zodra er genoeg nieuwe pogingen liggen:

- `rt_penalty` — hoe traag je in werkelijkheid blijkt te zijn bij de
  eerstvolgende keer ná een fout antwoord. Die tijd ís precies wat een fout
  voorspelde.
- `rt_prior` — de variantie binnen een som gedeeld door de variantie tussen
  sommen: de standaard empirische-Bayes-schatter voor hoe zwaar de familie moet
  meewegen.

`rt_target` is geen meting maar een keuze — hoe snel wil je zijn voordat een som
als beheerst geldt — en staat als instelling in de app.

`rt_decay` wordt bewust **niet** automatisch bijgesteld. Bij validatie tegen
gesimuleerde data met een bekende waarde bleek deze niet betrouwbaar te schatten:
reactietijden op één som variëren van keer tot keer sterker dan het effect van
een paar weken niet oefenen, waardoor de foutcurve over een breed bereik vlak
blijft. De app schat hem wel en legt de uitkomst met de spreiding vast in
`model_fits`, zodat dat oordeel bij meer data te herzien is.

Elke ijking wordt gelogd in `model_fits` met de gebruikte aantallen, en elke
uitkomst wordt geklemd op een verdedigbaar bereik. Een model dat zichzelf
bijstelt moet niet ongemerkt kunnen wegdrijven.

### Voortgang per preset

Het tabblad **Voortgang** zet per preset je aantal goede antwoorden per sessie
naast elkaar, oudste links, met een trendlijn erover. Of die lijn stijgt of daalt
staat er ook in woorden bij: kleur alleen is geen betrouwbare drager, en bij
kleurenblindheid vallen brons en roest tegen elkaar weg.

Een sessie hoort bij een preset zodra de **instellingen** overeenkomen — welke
categorieën aan staan en met welke bereiken — en niet zodra je toevallig op de
presetknop klikte. Anders zou dezelfde oefening in twee grafieken uiteenvallen.
Sessies die bij geen enkele preset passen krijgen geen grafiek; hoeveel dat er
zijn staat onder de toelichting. Dezelfde preset met een andere tijdslimiet
krijgt wel een eigen grafiek, want twee minuten en vijf minuten zijn niet met
elkaar te vergelijken.

Klik je op een staaf, dan klapt daaronder die ene sessie open: wanneer, hoe lang,
hoeveel goed en fout, je tempo, waar hij in de reeks staat en hoe hij zich tot je
gemiddelde verhoudt. De staaf zelf wordt inkt in plaats van brons, zodat je ziet
welke openstaat, ook zonder kleurwaarneming. Het klikvlak loopt over de volle
hoogte van de grafiek, want een lage staaf is anders nauwelijks te raken.

Een sessie weggooien kan op drie plekken: in dat opengeklikte detail, in de
sessielijst, en meteen op het resultaatscherm zodra je klaar bent. Dat laatste is
voor de sessie die je na drie seconden wegklikte — die hoef je dan niet eerst in
de statistieken op te zoeken. Weggooien trekt ook af wat de sessie aan je
somstatistiek bijdroeg, zodat je gemiddelden er niet door vertekend blijven.

Staat de sessie nog in de wachtrij omdat je geen verbinding had, dan wordt hij
daar weggehaald en heeft de database hem nooit gezien. Verwijderen terwijl het
opslaan nog loopt kan ook: de app wacht dat eerst af, anders zou de sessie er na
afloop alsnog in komen te staan.

### Datakwaliteit

- Draai je het scherm weg of word je onderbroken, dan staat de klok stil en telt
  die som niet mee in de gemiddelden.
- Sommen die veel te lang duren gelden als uitschieter. Die grens hangt af van
  je normtijd voor dat soort som, want een halve minuut kan bij 4-cijferig
  optellen echt zijn en is bij 6 x 7 overduidelijk een onderbreking.
- Een sessie telt eerst af van drie naar één. Zonder dat zat de tijd waarin je
  nog naar het scherm kijkt in de meting van je eerste som, bij elke sessie
  opnieuw.
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
| `model_params` | de vier parameters van het herhaalmodel |
| `model_fits` | logboek van elke ijking, met de gebruikte aantallen |

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
npm install        # alleen nodig voor de scripts hieronder
npm test           # controleert de somgeneratoren
npm run vendor     # bundelt supabase-js opnieuw naar vendor/supabase.js
npm run icons      # rendert icon.svg naar de PNG's voor iOS, Android en de tab
```

`icon.svg` is de bron van het app-icoon, in de kleuren van huis Atreides. iOS
accepteert geen SVG voor het thuisschermicoon en de bron bevat tekst, dus alleen
de uitgerenderde PNG's worden uitgeleverd: die zien er overal hetzelfde uit,
ongeacht welke letterfamilie een toestel heeft. Pas je het icoon aan, draai dan
`npm run icons` en commit de PNG's mee.

`vendor/supabase.js` staat bewust in de repo in plaats van op een CDN: zo laadt
de app zonder derde partij en blijft hij werken zonder bereik.

Een nieuwe oefensoort toevoegen is één blok in `modes.js` met `gen`, `build` en
`range`. De database hoeft daar niet voor te veranderen.
