# ETAT_PROJET.md : état de syncto

À lire après `AGENTS.md`. Mis à jour à chaque version.

---

## 1. État actuel

- **Version du code : 0.8.7** (07/10/2026). Dernière version publiée sur
  GitHub connue : 0.8.5 (la 0.8.6 a été livrée en ZIP le 05/10/2026 ; vérifier
  auprès de Noar si elle est en ligne). Releases publiées : 0.7.1 → 0.8.3 et 0.8.5. La 0.6.0 et la **0.8.4
  n'ont jamais été publiées** (le contenu de 0.8.4 est sorti avec 0.8.5).
- **Contenu de 0.8.6** (voir `CHANGELOG.md`) :
  - une paire re-pointée garde son historique de synchronisation ;
  - commentaire d'en-tête de `hash.js` corrigé ;
  - lanceurs de build renommés `build_mac.command` / `build_windows.command`
    (à la racine) ;
  - `scripts/push_github.command` (publication sur GitHub) ;
  - fichiers de suivi `AGENTS.md`, `ETAT_PROJET.md`, `CLAUDE.md` (renvoi) ;
  - `.syncto.db` et `.syncto.lock` cachés sous Windows.
- **Contenu de 0.8.7** : bandeau de run avec un titre par phase
  (SYNCHRONIZING / VERIFYING / FINISHING), anneau intérieur = phase en cours
  (0 → 100 %), anneau extérieur fin + « TOTAL x % » = tout le run.
- **Tests : 1169 vérifications, toutes vertes en 0.8.7** (1163 en 0.8.6, 1106
  en 0.8.5).
- Dépôt : https://github.com/noar-justedit/syncto (GPL-3.0), branche `main`.
- Versions des outils : Electron 43.5.0, electron-builder 26.15.3, Node 24 sur
  le Mac de Noar (≥ 20.19 exigé).

## 2. Le produit

syncto compare et synchronise des dossiers, sur le modèle de FreeFileSync. Une
fenêtre, des **paires** de dossiers (source → destination), un **mode**, puis
**COMPARE** (lecture seule) et **SYNCHRONIZE**. Chaque côté peut être un disque
local, un volume monté (NAS en SMB) ou un serveur **SFTP**
(`sftp://user@host:port/chemin`). Public : DIT, cadreurs, monteurs. Il partage
le langage d'interface des autres applications de Noar (ingesto, presto,
projecto, renamo…).

| Mode | Couleur | Ce qu'il fait |
|---|---|---|
| 2 WAYS | bleu | propage les changements dans les deux sens, grâce à `.syncto.db` |
| MIRROR | orange | la destination devient la copie exacte de la source (supprime ce que la source n'a plus). Compare date + taille, pas la base |
| UPDATE | vert | ajoute et met à jour, ne supprime jamais, n'écrase jamais une destination plus récente |
| CUSTOM | gris | ce que les réglages en font |

Un seul mode de copie depuis 0.5.0 : COMPARE → COPY → VERIFY (relecture et
xxHash64). La relecture n'est débrayable que pour les serveurs SFTP
(`verifyRemote`). Réglages : Main · S-FTP (1 à 10 transferts simultanés, 4 par
défaut) · Deletion · Notifications (ntfy). « Correct dates only » (0.8.4, off
par défaut) : taille identique + date différente → comparaison octet par octet ;
identique → seule la date est corrigée.

## 3. Décisions de Noar (et pourquoi)

- **On signale, on n'aide pas à deviner.** Dossier de job introuvable : rouge
  + fenêtre « Browse… ». La détection automatique de dossier renommé (0.6.0) a
  été retirée en 0.6.1 à sa demande.
- **Rien en pleine figure au démarrage** : un NAS pas encore monté le matin est
  normal. On marque, on n'ouvre pas de fenêtre.
- **Volume non monté** (0.8.3) : la comparaison refuse et nomme le disque. Un
  dossier vide resté dans `/Volumes` compte comme non monté.
- **Pas de corbeille sur un NAS** (0.8.3) : suppression définitive, annoncée
  dans la confirmation avant le run.
- **Supprimés en 0.8.3**, à ne pas réintroduire sans demande : rapports
  HTML/CSV/JSON, journal de diagnostic, jeton ntfy, « only when there is a
  problem ».
- **Gardés** (décision du 01/10/2026) : bouton « Send a test » de ntfy, aide de
  la fenêtre Filter.
- **Débit vers le NAS** (30/09/2026) : mesuré Finder 2 min, syncto 1 min. **On
  ne change rien au mode de copie.** Pistes abandonnées, à ne pas ressortir sans
  élément nouveau : tampon d'écriture doublé, tampon de lecture ajusté, copies
  parallèles vers un partage réseau, relecture débrayable sur NAS (codées,
  testées, retirées).
- **« Close » un job** le retire de la liste, ne supprime jamais le fichier.
- **Overview** (0.8.5) : un clic sélectionne, un double-clic ouvre (déroule +
  cadre la grille), lasso pour plusieurs lignes ; la flèche ▸ déroule sans cadrer.
- **Rouge réservé aux suppressions** (et aux dossiers/volumes absents depuis
  0.8.3). MIRROR est orange, pas rouge, pour éviter l'accoutumance.
- **Verrous sur le NAS** : syncto doit les régler sans intervention de Noar.
- **Build** : « je veux un truc simple ». Le build Mac fait tout (signature,
  notarisation). Noar a demandé de ne pas toucher au script Windows (0.5.6) ;
  toute modification des scripts de build passe par son accord.
- **Pas de `npm test` dans les scripts de build** (Linux compris depuis le
  01/10/2026) : lancer la suite à la main avant de livrer.
- **Profil de test isolé** pour lancer l'app sur le Mac : abandonné (03/10/2026).
- **Fichiers de syncto cachés sous Windows** (05/10/2026) : `.syncto.db` et
  `.syncto.lock` ; `syncto-checksums.txt` reste visible (preuve de relecture).
  Windows seulement : rien de posé depuis le Mac pour l'instant.
- **Notes privées supprimées** (03/10/2026) : tout le suivi est public, dans
  `AGENTS.md` et ce fichier (règles ARNO DEV).

Principes tirés de l'historique : une fenêtre qui travaille sans rien afficher
passe pour plantée ; ne jamais afficher une progression qu'on ne sait pas
calculer ; un chiffre dit de quoi il parle (« Left to copy ») ; une option qui
retire une garantie le dit là où on lit le résultat ; ce qu'on montre d'un run
vient du moteur, pas du réglage ; erreurs et notes sont copiables ; une action
par lot laisse de quoi la défaire au même endroit ; un message qui expose un
code système (`EISDIR`, `ENOTSUP`) est un bug d'interface.

## 4. Architecture en bref

Trois couches :
1. **Moteur** (`src/main/core`, `src/main/fs`) : aucune dépendance à Electron,
   testable avec `node` seul.
2. **Processus principal** (`src/main/main.js`) : fenêtre, menus, IPC,
   préférences, mots de passe, notifications, action de fin, vérification de
   mise à jour (`version.json` lu sur GitHub).
3. **Fenêtre** (`src/renderer/index.html` + `app.js`, sans framework) :
   sandboxée, CSP stricte, tout passe par `src/main/preload.js`.

| Fichier | Rôle |
|---|---|
| `src/main/preload.js` | pont fenêtre ↔ moteur. **Chaque argument doit passer** (section 41 des tests compare l'arité) |
| `src/main/config.js` | format du job `.syncto`, chargement/normalisation, préférences, récents |
| `src/main/secrets.js` | mots de passe via `safeStorage` |
| `src/main/notify.js` / `power.js` | ntfy ; action de fin (veille, extinction, quitter) |
| `src/main/core/compare.js` | parcours des deux côtés (32 `lstat` en vol), catégorisation |
| `src/main/core/direction.js` | catégorie → sens → opération, règles des modes, détection de déplacement |
| `src/main/core/sync.js` | `SyncRunner` : copie, suppression, renommage, relecture, dates, progression |
| `src/main/core/session.js` | `Session` (une paire), `MultiSession`, overview, lignes de la grille |
| `src/main/core/db.js` | `.syncto.db` : état du dernier run |
| `src/main/core/lock.js` | `.syncto.lock` : verrous entre machines, orphelins |
| `src/main/core/volume.js` | volume non monté (/Volumes, lettre, UNC, /media, /mnt) |
| `src/main/core/relpath.js` | chemins relatifs sûrs (rien ne sort du dossier choisi) |
| `src/main/core/filter.js` / `versioning.js` / `hash.js` | filtres ; corbeille / révisions / suppression ; xxHash64 (hash-wasm) |
| `src/main/fs/native.js` / `sftp.js` / `sftp-pipe.js` | disque local ou monté ; SFTP ; flux SFTP pipelinés (64 requêtes en vol) |
| `test/run-tests.js` | la suite, sans framework (`ok()`, `eq()`), table `SECTIONS` dans `main()` |
| `test/sftp-server.js` / `lock-holder.js` | vrai serveur SFTP avec latence ; second processus pour les verrous |
| `scripts/` | builds, notarisation (`notarize-lib.sh`), captures (Linux), icônes, `ffs-convert.js`, `push_github.command` |

Dépendances d'exécution : `ssh2`, `hash-wasm` seulement. Rien à compiler, mais
ssh2 tire `cpu-features` et `nan` en optionnels : `electron-builder.yml` les
exclut et met `npmRebuild: false`, sinon le build Windows depuis le Mac échoue.

### Un run, dans l'ordre
1. `MultiSession.compare()` : pour chaque paire, `Session` lit `.syncto.db`
   (estimation du nombre d'éléments), parcourt les deux côtés, catégorise,
   applique le mode. Volume absent : refus (`volume.js`).
2. SYNCHRONIZE : `checkRootsStillThere()`, verrous sur chaque dossier
   (`acquireAll(..., { mayCreate })` : seuls les dossiers vus absents à la
   comparaison peuvent être créés).
3. `SyncRunner` : dossiers, copies (fichier `.syncto_tmp`, contrôle de taille,
   **flush avant la date**, renommage), suppressions, passe de **relecture**
   (xxHash64 recalculé), `keepDate()`.
4. Ce qui n'a pas été relu n'est jamais marqué « synchronisé » (`dropUnproven`).
5. Base écrite des deux côtés avec le **même `stamp`**, `syncto-checksums.txt`,
   verrous libérés, re-comparaison silencieuse (« CHECKING »), résumé,
   notification, action de fin.

### Ce que syncto écrit dans les dossiers de l'utilisateur
- `.syncto.db` (gzip JSON, lecture plafonnée à 16 Mo) à la racine de chaque
  dossier de base. Caché par le point sur macOS / Linux ; **sous Windows,
  attribut « caché » posé après chaque écriture** (`attrib +h` via
  `NativeFs.setHidden`, `windowsHide`, sans jamais faire échouer le run). Si
  Windows refuse de remplacer le fichier caché, l'attribut est retiré et le
  renommage retenté une fois. Une entrée (« session ») par paire. Si les deux copies n'ont
  pas le même `stamp`, la base est ignorée (comparaison simple).
- `.syncto.lock` + `Delete.N..syncto.lock` pendant un run, **cachés sous
  Windows** depuis 0.8.6 (attrib lancé sans être attendu à la création ;
  `release()` l'attend avant de supprimer le fichier, Windows refusant de
  supprimer un fichier ouvert par un autre programme) ; signes de vie
  réguliers ; abandonné après 60 s de silence (`DETECT_ABANDONED_MS`). Un verrou
  déjà plus vieux que 60 s + 60 s au démarrage est repris tout de suite.
- `syncto-checksums.txt` : la preuve de la relecture (optionnel).

### Identité d'une paire et historique (`db.js`, `session.js`)
- `pairIdFor` calcule l'identifiant d'une paire à partir de ses **deux
  chemins** (ordre compris : un swap repart de zéro).
- **Depuis 0.8.6** : quand l'utilisateur change
  un chemin dans la fenêtre (saisie, Browse, fenêtre relink), la paire garde ses
  anciens chemins dans `pair.was` (fichier job + préférences). `Session.compare`
  lit l'historique sous l'ancien identifiant quand le nouveau n'en a pas,
  **seulement si les deux dossiers ont cette session avec le même `stamp`**
  (`previousPairId`). Viser un autre dossier repart donc de zéro, comme avant.
  Un swap n'est pas un re-pointage (`swapPair` inverse `was`, et un ancien
  chemin passé de l'autre côté est refusé). `was` est effacé après un run qui a
  écrit la base (`res.dbSaved` → `dropCarriedPaths`). L'ancienne session n'est
  jamais supprimée : un autre job peut utiliser ces chemins.
- Choix écarté : un identifiant fixe stocké dans le job. « Save As » l'aurait
  recopié, et deux jobs dupliqués vers deux disques se seraient écrasé
  l'historique à chaque run.

### Points délicats du moteur
- `compare.js` range un désaccord de type (lien d'un côté, fichier de l'autre)
  en `type: 'file'` pour l'afficher. **Le moteur de copie ne fait jamais
  confiance à ce type** : il relit le disque.
- Noms en NFD sur macOS, NFC ailleurs : `relL` / `relR` portent l'orthographe
  de chaque côté.
- SFTP : clé du serveur vérifiée (`knownHosts`), noms contenant `/` ou `\`
  refusés. `ssh2` a une fenêtre de 2 Mo en dur → une connexion plafonne à
  2 Mo ÷ latence, d'où plusieurs connexions (« voies »). Les flux ssh2 ne
  pipelinent pas : `sftp-pipe.js` garde 64 requêtes en vol et remet les blocs
  en ordre.

### Profil (sur la machine)
`app.getPath('userData')/preferences.json` : job ouvert, récents, serveurs,
`knownHosts`, largeurs de colonnes. Écrit atomiquement et **fusionné** avec ce
qu'une autre fenêtre syncto a écrit (plusieurs instances possibles : File ›
New syncto window, `Cmd+Alt+N`). Jamais de mot de passe dedans (`scrubSecrets`).

### La fenêtre
`state` global dans `app.js` ; grille virtualisée (`getRows` par fenêtre
visible). Overview : arbre, le moteur ne construit que les niveaux ouverts
(`state.ovOpen`), sélection `state.ovSel`. Pendant un run, `#app.running`
bloque modes, paires et lignes ; la liste et l'Overview se vident.

## 5. Charte UI

Commune aux applications de Noar (arrêtée sur ingesto 2.7.0). Dans syncto, un
seul bloc **« CHARTE UI »** à la fin de la feuille de style de
`src/renderer/index.html`, juste avant l'unique `</style>`, redéfinit par-dessus
les anciennes règles. Les retouches se font là ; la section 42 des tests en
vérifie les promesses.

- Trois surfaces : page `#0a0b0e`, carte `#14161c`, creux `#0e1014` ; `--raise
  #1b1d24` pour ce qui flotte. **Aucune bordure de structure** : un contour ne
  dit qu'un état. 12 px entre deux cartes ; rayons 14 / 11 / 8 / 4.
- États : `--green #35c98b` fait/vérifié, `--red #f2555a` suppression ou échec,
  `--blue #4d90f0` neutre, `--orange #f2a03d` à décider. Badge : couleur sur
  fond de la même couleur à 15 %. Texte : `#e8eaf0`, `#aeb3bd`, `#8b909b`,
  `#6f757f`. Étiquettes en capitales 10/700, interlettrage .14em. Chasse fixe
  pour chemins et nombres.
- **Accent cyan `#2cc4ea`** : uniquement le « to » du logo. Écartés : sarcelle
  (renamo), glacier (illisible sur Dock clair), magenta (presto).
- Icône « Boucle » : deux arcs, blanc en haut, cyan en bas. Source
  `build-resources/icon.svg`, formats régénérés par `scripts/gen-icons.py`
  (`pip install cairosvg` ; pas de `--` dans un commentaire XML).
- Modes : picto sur pastille teintée ; 2 WAYS bleu, MIRROR orange, UPDATE vert,
  CUSTOM gris ; le mode choisi est entouré de sa couleur. Compare bleu,
  Synchronize vert. Titres SOURCE / DESTINATION gris.
- Grille : rouge = sera supprimé, déplacement en bleu. Filtre actif : orange.
  Job chargé : vert dans la liste JOBS.
- Bandeau de run en bas (`.live`) : un titre par phase depuis 0.8.7 (choix de
  Noar, avant : SYNCHRONIZING pour tout le run) : SYNCHRONIZING vert en copie,
  VERIFYING bleu en relecture, FINISHING pour la fin, PAUSED gris ;
  COMPARING / CHECKING bleu. Deux anneaux pendant un run : intérieur = phase en
  cours (0 → 100 %, grand chiffre), extérieur fin gris + « TOTAL x % » = tout
  le run (comme la barre du haut). En multi-paire, chaque paire fait copie puis
  relecture : l'anneau intérieur repart pour chacune. Une comparaison n'a
  qu'un anneau. Rien ne bouge si le
  système demande de réduire les animations. Fenêtres : voile noir 70 %.
- Toute icône seule a un `aria-label`. Échap ferme ce qui informe.
- Écarts assumés (demandés par Noar) : ascenseurs de 13 px ; poignées de
  redimensionnement des panneaux ; colonnes Size / Date redimensionnables
  (`--szL/--dtL/--szR/--dtR`, mémorisées dans `ui.cols`).

## 6. NAS en SMB (macOS)

- **Dates** (0.8.4 → 0.8.5) : le client SMB de macOS garde la fin d'un fichier
  en cache et l'envoie plus tard ; le NAS re-date alors le fichier. Ordre
  obligatoire dans `sync.js` : écriture `.syncto_tmp` → **flush** → date →
  renommage → après relecture, `keepDate()` (si la date a bougé de plus d'1 s,
  elle est reposée et une note le dit). Vérifié par Noar : 0 s d'écart, comme
  FreeFileSync.
- **Débit** : voir Décisions. Mesures (1085 fichiers, 210 Mo) : par fichier,
  écriture 10 ms, renommage 9–10 ms, fsync 5–7 ms, date 4–5 ms ; le NAS varie de
  ±30 %, toujours mesurer deux passes.
- **Verrous** : `link()` sur un partage SMB répond `ENOTSUP` ; `renameStrict`
  se replie sur `rename` (0.8.5).

## 7. Build, signature, publication

- **Mac (arm64)** : `build_mac.command` (ou `./build.sh`). Signe avec le
  certificat « Developer ID Application » du Trousseau, notarise (identifiants
  dans le Trousseau, profil `syncto-notarization`, demandés la première fois
  seulement), agrafe le `.dmg`, vérifie avec `spctl`. Si la notarisation échoue,
  relance une fois sans elle. `--sign-check` : rapport sans build ;
  `SYNCTO_SKIP_SIGN=1` : build non signé. Entitlements : Apple events
  (extinction auto), pas de `disable-library-validation`.
- **Windows x64 depuis le Mac** : `build_windows.command` (ou `./build.sh --win`).
  Réaliste parce que syncto ne compile rien. `.zip` portable toujours ;
  installeur `.exe` si Wine est installé (`brew install --cask wine-stable`).
  Non signé : SmartScreen avertit au premier lancement.
- **Linux** : `bash scripts/build-linux.sh`, **sur une machine Linux** (ou une
  VM Ubuntu) ; pas réaliste depuis le Mac (un `.deb` produit sous macOS est
  invalide, constaté sur ingesto). AppImage + `.deb`.
- **Publication** : `scripts/push_github.command` (voir AGENTS.md, règle 7). Il
  clone le dépôt dans un dossier temporaire, le rend identique au dossier
  (sans `node_modules`, `dist`, `.git`, `.DS_Store`), remet le bit d'exécution
  sur `*.command` / `*.sh`, refuse si la version n'est pas supérieure à celle de
  GitHub ou si `version.json` ≠ `package.json`, retient `version.json` tant que
  la Release `vX.Y.Z` n'existe pas (API GitHub publique), liste les changements,
  attend « y », pousse sur `main` sans jamais forcer. Identifiants : ceux du
  GitHub CLI (`gh`) s'il est connecté, sinon git les demande (le Trousseau les
  garde). Variables pour les tests seulement : `PUSH_GITHUB_REMOTE`,
  `PUSH_GITHUB_RELEASE`.
- `npm audit` : 11 « high » (brace-expansion, fast-uri, http-cache-semantics,
  undici), toutes dans electron-builder / @electron/get. Corrigées seulement
  dans les préversions 27 d'electron-builder : attendre une 27 stable, puis
  refaire un build Mac et Windows de contrôle.

## 8. Tests

`npm test` = `node test/run-tests.js`, 48 sections, environ 4 minutes. Vrais
fichiers, vrais verrous, second processus, vrai serveur SFTP avec latence, vrai
dépôt git local pour le script de publication. Une exception dans une section
est rapportée `UNCAUGHT in <nom>`, les autres tournent quand même.

- Sections utiles : 26 (lignes de commande Apple des scripts de build,
  vérifiées contre `notarytool(1)`), 33 (verrous, `timing` court), 41 (arité du
  pont preload), 42 (charte), 47 (paquets Linux, `basic_text`), 48 (demandes
  0.8.x, blocs `d1`…`d14`).
- Un test de la section 44 est sensible au temps : s'il échoue isolément sur une
  machine chargée, relancer avant de chercher.
- Règles d'écriture : tester le comportement, pas le commentaire ; tester le
  wrapper, pas seulement la fonction pure ; données non répétitives ; cas
  limites de taille (0 octet, un bloc) ; un stub valide ses arguments comme le
  vrai binaire ; ne jamais toucher `/proc` ; `new Event('change', { bubbles:
  true })`.
- L'interface se vérifiait jusqu'en 0.8.5 dans un conteneur Linux (Xvfb +
  protocole DevTools, `scripts/shots.js`, `shots-linux.sh`, `shot-dataset.sh`).
  Ces scripts sont écrits pour ce conteneur ; **`shot-dataset.sh` fait des
  `rm -rf` sous `/Volumes/` : ne jamais le lancer sur un Mac.**
- Ne se teste que sur un vrai Mac : signature, notarisation, Apple events,
  comportement réel d'un partage SMB, installeur NSIS.

## 9. Pièges connus (ce qui a déjà coûté du temps)

- Un pont `preload` qui perd un argument ne fait **aucun bruit** (l'extinction
  auto n'a jamais marché jusqu'en 0.7.3). Un défaut sur Mac ET Windows : la
  cause est dans le code commun.
- Une lecture qui échoue ne prouve pas l'absence (`checkStillOurs` : `ours |
  taken | gone | unknown`). Le verrou est la première écriture : destination en
  lecture seule = la comparaison passe, la synchro meurt au verrou.
- Bundles `.app` : les liens d'un `.framework` restent des liens ; décider du
  type d'après un `lstat` frais.
- Dossiers de service de l'OS (`.Spotlight-V100`, `.fseventsd`…) partent avec
  leur parent ; `.Trashes` et `$RECYCLE.BIN` exclus de cette règle.
- Comparaison octet par octet entre disques natifs : lectures positionnées, pas
  de flux (bloqué à 0 % sur NAS en 0.8.4).
- `fsync` gardé avant chaque relecture (coût mesuré : 26 s sur 59 pour 5 000
  petits fichiers) : la relecture sortirait sinon du cache.
- SFTP : `fastGet`/`fastPut` feraient perdre l'empreinte au vol et la pause ;
  un fichier vide n'atteint jamais `_write` ; une lecture courte n'est pas une
  fin de fichier ; `generateKeyPairSync('ed25519')` de ssh2 produit parfois une
  clé invalide (le serveur de test régénère).
- macOS signé : un Apple event exige l'entitlement
  `com.apple.security.automation.apple-events` et `NSAppleEventsUsageDescription`.
- `navigator.clipboard` ne marche pas dans ce renderer : IPC `copy-text`. Ne
  jamais poser un raccourci déjà pris par un `role:` Electron (⌘W).
- Tout fichier écrit à un chemin fixe du profil doit supporter deux instances.
- CSS : une cellule de grille trop étroite écrit **par-dessus** sa voisine
  (`overflow:hidden` + ellipsis, revérifier à 210 px) ; `min-height:0` sur tout
  enfant flex scrollable ; `style.display = ''` ne montre pas un élément caché
  par la feuille de style.
- `git archive` et l'upload web de GitHub perdent le bit exécutable : un
  `.command` en 644 répond « insufficient access privileges ». Les lanceurs
  remettent les droits eux-mêmes ; `push_github.command` les force sur GitHub.
- rsync saute un fichier de même taille et même date : `push_github.command`
  vide la copie puis recopie tout.
- Ne pas construire depuis un partage NAS (npm n'y crée pas ses liens).
- Vérifier qu'une édition a bien atterri avant de conclure.

## 10. Problèmes connus

- **Section « Regenerating the screenshots » du README périmée** : elle décrit
  le script Linux à 10 images, alors que la capture 0.8.5 est faite à la main.
  En attente d'une décision de Noar (réécrire, supprimer ou laisser).
- **Revenir à d'anciens chemins** relit leur vieille session, qui peut être plus
  ancienne que le dernier run fait sous d'autres chemins (antérieur à 0.8.6).
- `checkJobPaths` (`session.js`, vérification des volumes absents) passe
  `job.pairId` même en multi-paire, alors que compare/sync le mettent à `null`.
  Sans effet hors très vieux jobs portant un `pairId`.
- Le re-pointage ne joue que pour les changements faits **dans syncto** : un
  `.syncto` modifié à la main ne garde pas les anciens chemins.
- `npm audit` : voir section 7.
- `.syncto.db` et `.syncto.lock` cachés sous Windows : pas encore essayé sur
  un vrai PC (disque local et NAS). Pour effacer un verrou à la main sous
  Windows, il faut maintenant afficher les éléments masqués. Un disque exFAT ou un NAS écrit **depuis le Mac** garde une
  base visible sous Windows (le Mac ne pose pas l'attribut ; `chflags hidden`
  serait la piste, non décidée).
- Noar dit devoir **souvent effacer des `.syncto.lock` à la main**, alors que
  0.8.5 devait régler ça sans intervention : à instruire (message exact,
  machine, NAS ou disque local).

## 11. Prochaines étapes

0. Sur un PC Windows : pendant un run, `.syncto.lock` est caché ; après,
   `.syncto.db` est caché et le verrou a disparu ; un second run remplace la
   base sans erreur. Sur un disque local et sur le NAS.
1. Vérifier sur le Mac, avec une paire de test en 2 WAYS : Synchronize, renommer
   le dossier de destination dans le Finder, le re-pointer, supprimer un fichier
   à la source, Compare → le fichier doit être prévu en **suppression à
   droite**.
2. Première publication avec `scripts/push_github.command` (identifiants GitHub
   à fournir la première fois ; l'appel à l'API GitHub qui détecte la Release
   n'a pas pu être testé hors du Mac).
3. Section « Regenerating the screenshots » du README (voir Problèmes connus).
4. electron-builder 27 stable, quand elle sortira.

## 12. Historique des versions

| Version | Date | Tests | Contenu principal |
|---|---|---|---|
| 0.5.x | août–sept. 2026 | 447–528 | un seul mode de copie, notarisation, bundles `.app` |
| 0.6.0–0.6.2 | 05/09 | 572–622 | dossier de job disparu (signaler, pas deviner), verrous réseau, orphelins |
| 0.6.3–0.6.6 | 07/09 | 665–698 | journal, SFTP pipeliné (×50 sous latence), serveur SFTP de test |
| 0.6.7 / 0.7.0 | 10–11/09 | 733–782 | Overview en arbre, tri, sélection par lot, filtre explicite |
| 0.7.1 | 14/09 | 810 | vue restreinte, ascenseurs 13 px, vue de run, chevrons de sens |
| 0.7.2 | 19/09 | 888 | SFTP plus rapide, voies, relecture débrayable sur serveur ; plusieurs fenêtres |
| 0.7.3 | 20/09 | 899 | extinction auto (pont preload + Apple events), droits d'exécution |
| 0.7.4 | 21/09 | 928 | charte UI, accent cyan, icône Boucle |
| 0.8.0 | 24/09 | 1044 | audit : sécurité, défauts moteur, vitesse ×3–10, interface |
| 0.8.1 | 24/09 | 1050 | une couleur par mode |
| 0.8.2 | 25/09 | 1065 | Linux (AppImage + .deb), `basic_text` refusé |
| 0.8.3 | 30/09 | 1071 | volume non monté, run dans la fenêtre, réglages sur un écran, suppressions |
| 0.8.4 | 30/09 | 1090 | dates sur NAS, Correct dates only, colonnes redimensionnables (**jamais publiée**) |
| 0.8.5 | 30/09 | 1106 | Overview clic / double-clic / lasso ; flush avant date ; verrous NAS |
| 0.8.6 | 05/10 | 1163 | historique des paires re-pointées, base et verrou cachés sous Windows, `push_github.command`, fichiers de suivi |
| 0.8.7 | 07/10 | 1169 | bandeau de run : un titre par phase, anneau de phase + anneau du run |

Le détail est dans `CHANGELOG.md`.

## 13. Emplacements de la version

À mettre à jour **tous** à chaque bump, puis vérifier avec
`grep -rn "X.Y.Z" package.json package-lock.json version.json CHANGELOG.md` :

1. `package.json` : champ `"version"` (ligne 3) ; l'app l'affiche
   (`app.getVersion()`).
2. `package-lock.json` : les **deux** champs `"version"` en tête (lignes 3 et 9).
3. `version.json` : champ `"version"` (déclenche l'alerte de mise à jour chez
   tous les utilisateurs une fois sur GitHub ; `push_github.command` le retient
   jusqu'à la Release).
4. `CHANGELOG.md` : titre `## [X.Y.Z] — AAAA-MM-JJ` (remplace « Unreleased »).
5. `ETAT_PROJET.md` : sections 1 (état actuel) et 12 (historique).
6. Les commentaires « (X.Y.Z) » des changements de la version, dans le code et
   les tests, s'ils ont été écrits avec un autre numéro.
