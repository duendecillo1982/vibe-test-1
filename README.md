# Komesjes

Een gedeelde webapp waarin gezinsleden producten kunnen toevoegen die op zijn, en deze in de supermarkt kunnen afvinken zodra ze in de winkelkar liggen.

## Architectuur

- Frontend: statische site op Netlify.
- API: Netlify Function op `netlify/functions/api.js`.
- Data: Postgres cloud database via connectiestring (`NETLIFY_DATABASE_URL` of `DATABASE_URL`).

## Deploy op Netlify (alles via Netlify)

1. Push dit project naar GitHub/GitLab/Bitbucket.
2. Maak een nieuwe Netlify site vanuit die repository.
3. In Netlify:
   - Build command: leeg laten (of `npm install`)
   - Publish directory: `.`
4. Voeg een Postgres database toe en zet de connectiestring als environment variable:
   - `NETLIFY_DATABASE_URL` (aanbevolen)
   - of `DATABASE_URL`
5. Redeploy de site.

Na deploy werkt alles direct via dezelfde Netlify-URL.

## Functies

- Meerdere gezinnen met gescheiden lijsten via gezinsnaam + pincode.
- Startscherm met keuze tussen inloggen of nieuw gezin aanmaken.
- Per toestel blijft een veilige sessie-token bewaard, zodat de juiste lijst direct opent zonder pincode in URL.
- Product toevoegen met naam, optioneel aantal en naam van gezinslid.
- Producten worden opgeslagen in cloud Postgres.
- In de lijst staan niet-afgevinkte producten automatisch bovenaan.
- Afgevinkte producten kunnen in 1 klik verwijderd worden.
- Hele lijst in 1 keer leegmaken (met bevestiging).
- Automatische synchronisatie met server (iedere paar seconden).

## Troubleshooting

- `NetworkError when attempting to fetch resource` lokaal:
  - Je opent waarschijnlijk `index.html` direct als bestand (`file://`) of zonder function runtime.
  - Oplossing: test via Netlify deploy URL, of lokaal via Netlify CLI (`netlify dev`).

- `Database is niet geconfigureerd`:
  - Zet `NETLIFY_DATABASE_URL` of `DATABASE_URL` in Site settings -> Environment variables.

- `Endpoint niet gevonden`:
  - Controleer of `netlify.toml` mee gedeployed is en de redirect `/api/*` actief is.
