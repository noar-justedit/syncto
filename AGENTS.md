# AGENTS.md : règles pour toute IA qui travaille sur syncto

Ce fichier est lu en premier, par n'importe quelle IA (Claude, Codex, Gemini…).
`CLAUDE.md` ne fait que renvoyer ici. L'état du projet, son architecture, ses
décisions et ses problèmes connus sont dans **`ETAT_PROJET.md`** : le lire
ensuite, en entier, avant de toucher au code.

---

## Règles de développement (projets de Noar)

### Contexte
- Noar est monteur et technicien vidéo, pas développeur. Il travaille uniquement sur Mac.
- Ses applications doivent tourner sur Mac et Windows (et sur Linux quand le projet le prévoit).
- Il publie lui-même sur GitHub : le code à partir du ZIP fourni, et les builds dans les Releases.

### 1. Périmètre : rien en dehors de la demande
- Ne modifier que ce qui est demandé.
- Pour tout le reste (outillage, scripts de build, dépendances, organisation des fichiers,
  comportements par défaut) : proposer, expliquer l'impact, puis attendre un « oui » explicite.
  Jamais d'initiative silencieuse.

### 2. Communication
- Répondre en français, simplement, sans jargon.
- Expliquer en quelques phrases ce que fait le code et pourquoi cette méthode plutôt qu'une autre.
- Signaler les conséquences concrètes : ce qui peut casser plus tard, ce qui sera difficile
  à modifier, les limites de la solution, les impacts sur le coût, la sécurité, la maintenance
  et les performances.
- Pas de flatterie. Si Noar se trompe, le lui dire et expliquer pourquoi.

### 3. Builds
- Chaque projet contient des scripts `build_*.command` qui génèrent depuis le Mac
  la version Mac, la version Windows et, selon le projet, les versions Linux (.deb, AppImage).
- Si un build Windows ou Linux depuis le Mac n'est pas réaliste, le dire clairement
  et proposer une autre solution.
- Ces scripts sont créés au démarrage du projet. Toute modification qui n'a pas été demandée
  suit la règle 1.

### 4. Versions
- Aucun bump sans que Noar ait confirmé explicitement le numéro.
- Procédure : proposer un numéro, attendre la confirmation, mettre à jour tous les emplacements
  listés dans `ETAT_PROJET.md` (section « Emplacements de la version »), puis vérifier
  qu'aucun n'a été oublié.
- Format : X.Y.Z.

### 5. Livraison : le ZIP
- À chaque bump, fournir `NomDuProjet_vX.Y.Z.zip`.
- Une fois décompressé, le ZIP correspond exactement à ce que Noar pousse sur GitHub :
  sources, scripts de build, documentation et fichiers de suivi.
- Le ZIP ne contient pas :
  - les builds, qui vont dans les Releases ;
  - les dossiers générés (node_modules, dist, build…) ;
  - aucun secret (mot de passe, clé API, certificat de signature).
- Le ZIP doit suffire à lui seul pour que n'importe quelle IA, pas seulement Claude,
  reprenne le développement.

### 6. Fichiers de suivi (dans le ZIP, à jour à chaque bump)
- `README.md` : ce que fait l'app et comment la builder.
- `AGENTS.md` : ces règles, lisibles par toute IA. `CLAUDE.md` renvoie vers `AGENTS.md`.
- `ETAT_PROJET.md` : état actuel, architecture en bref, décisions prises et leurs raisons,
  problèmes connus, prochaines étapes, emplacements de la version.
- `CHANGELOG.md` : historique des versions.

### 7. Publication sur GitHub : scripts/push_github.command
- Chaque projet contient `scripts/push_github.command`. Noar décompresse le ZIP et
  double-clique ce script dans le dossier obtenu : GitHub devient exactement le
  contenu du dossier (ajouts, modifications et fichiers retirés). Jamais d'envoi
  par l'upload web de GitHub (il ne supprime rien et perd les droits d'exécution).
- Le script travaille dans une copie temporaire du dépôt, affiche la liste des
  changements et attend un « y ». Jamais d'envoi forcé.
- Chaque envoi porte une nouvelle version : le script refuse d'envoyer si la version
  de `version.json` n'est pas strictement supérieure à celle publiée sur GitHub, ou si
  `version.json` et `package.json` ne disent pas le même numéro.
- `version.json` part en dernier : tant que la Release et ses binaires ne sont pas
  publiés, le script garde l'ancien sur GitHub ; on le relance ensuite pour l'envoyer.
- Tout projet doit avoir un `version.json` (le script y lit la version, et l'adresse
  GitHub si `package.json` ne la donne pas).

---

## Propre à syncto

### Langues
- À Noar : français. Code, commentaires, messages de commit, interface, README,
  CHANGELOG et notes de release : **anglais**.

### Interdits et réflexes
1. **L'IA ne pousse jamais sur GitHub.** Commits locaux autorisés ; la
   publication passe par `scripts/push_github.command`, lancé par Noar.
2. **Avant d'écrire une note de release, demander à Noar quelle version est en
   ligne sur GitHub.** Ne jamais le déduire (trois notes ratées : 0.5.3, 0.5.11,
   0.6.2, qui republiaient du déjà publié).
3. **Aucun mot de passe en clair nulle part.** Trousseau macOS, Gestionnaire
   d'identifiants Windows, libsecret sous Linux, via `safeStorage`
   (`src/main/secrets.js`). Sous Linux, le backend `basic_text` est refusé (sa
   clé est dans le source d'Electron). Un chemin `sftp://user:motdepasse@…` est
   toujours expurgé avant d'être écrit (`redactLocation`).
4. **Ne pas lancer `npm audit fix`.** Les alertes « high » viennent
   d'electron-builder et de @electron/get (outils de build), jamais de l'app
   livrée (`npm audit --omit=dev` : 0).
5. **Ne pas lancer l'application sur le Mac de Noar sans le prévenir**
   (`npm run dev`) : elle ouvre **son vrai profil** (préférences, jobs récents,
   serveurs enregistrés). Ne jamais lancer une synchro sur ses dossiers.
6. **Ne jamais re-cibler un job tout seul**, ne jamais proposer de dossier de
   remplacement. syncto signale (rouge + fenêtre Browse), l'utilisateur décide.
7. **Ne jamais ajouter `npm test` (ni rien d'autre) aux scripts de build** sans
   accord : c'est arrivé sur presto 2.1.0 et a bloqué deux builds.
8. **Ne pas toucher au mode de copie ni au débit vers un NAS** : décision de Noar
   (voir `ETAT_PROJET.md`, NAS).
9. **Ne jamais inventer une option de ligne de commande** : vérifier la page de
   manuel (`notarytool history --limit` n'existe pas, un zip perdu en 0.5.6).

### Commandes

```bash
npm install                                         # dépendances (une fois)
npm test                                            # suite complète, ~4 min
SYNCTO_ONLY=testRequest083 node test/run-tests.js   # une ou plusieurs sections (virgules)
npm run dev                                         # lance l'app sans build (vrai profil !)
./build_mac.command                                 # Mac arm64 .dmg, signé + notarisé (double-clic)
./build_windows.command                             # Windows x64 depuis le Mac (double-clic)
bash scripts/build-linux.sh                         # AppImage + .deb, sur une machine Linux uniquement
./build.sh --sign-check                             # rapport de signature sans build
scripts/push_github.command                         # publication, par Noar (double-clic)
```

Dans un environnement de test sans Electron : `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`
suffit, la suite n'a pas besoin du binaire.

### Méthode de travail
- **Reproduire avant de corriger**, même quand la cause paraît évidente.
- **Chaque défaut corrigé a son test**, nommé d'après le défaut, dans la section
  de la version en cours (les demandes 0.8.x sont dans la section 48,
  `testRequest083`, blocs `d1`…`d14` ; une nouvelle version peut continuer là ou
  ouvrir la section 49).
- **Vérifier un test en le cassant** : remettre l'ancien code, constater que le
  test passe au rouge, remettre en état.
- Beaucoup de tests lisent `app.js` / `index.html` avec des expressions
  régulières. Renommer une fonction peut les casser : **adapter la lecture,
  garder l'intention**, ne jamais supprimer le test.
- **Mesurer plutôt que supposer** (débit, temps, taille de texte dans une
  cellule). Une interface se vérifie sur l'app qui tourne, pas sur le code ; si
  on ne peut pas la lancer, le dire à Noar et lui décrire quoi vérifier.
- Quand Noar remonte une erreur, **demander la sortie brute** (message exact,
  capture) avant de coder.
- Les commentaires « (X.Y.Z) » du code portent la version où le changement sort.

### Livrer une version
1. Le travail est fait, `npm test` est vert, Noar a vu le résultat.
2. Proposer un numéro, attendre sa **confirmation**.
3. Mettre à jour tous les « Emplacements de la version » de `ETAT_PROJET.md`,
   puis vérifier (`grep`) qu'aucun n'a été oublié.
4. Mettre à jour `CHANGELOG.md` et `ETAT_PROJET.md` (état, historique,
   problèmes connus, prochaines étapes) ; `README.md` si l'usage ou le build a
   changé.
5. `npm test` encore ; noter le nombre de vérifications dans `ETAT_PROJET.md`.
6. Commit local, message en anglais : `X.Y.Z: résumé en une ligne`, puis le
   détail.
7. **Demander quelle version est en ligne**, puis écrire la note de release
   (anglais) depuis celle-là. Modèle : titre, chapeau, « **N checks pass**, up
   from M at X.Y.Z », sections Fixed / Added / Changed / Removed,
   « Upgrading », plateformes, bloc de build.
8. Fournir **`syncto_vX.Y.Z.zip`** : le dossier tel qu'il doit être sur GitHub,
   sans `node_modules/`, `dist/`, `.git/`, `.DS_Store`, droits d'exécution
   conservés sur `*.command` et `*.sh`.
9. Noar construit (`build_mac.command`, `build_windows.command`), lance
   `scripts/push_github.command` (le code part, `version.json` attend), publie
   la Release `vX.Y.Z` avec les binaires, puis relance le script pour envoyer
   `version.json` (qui déclenche l'alerte de mise à jour chez tous les
   utilisateurs).
