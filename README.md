# LeakZero

[![CI](https://github.com/timoogo/leakzero/actions/workflows/ci.yml/badge.svg)](https://github.com/timoogo/leakzero/actions/workflows/ci.yml)


Extension Chrome (Manifest V3) qui réduit les risques de fuite d'informations pendant un livestream :
masquage des numéros de téléphone dans le texte et des images/vidéos, sur n'importe quelle page web,
et module **Notes** : une fiche par conversation Snapchat Web, dans une fenêtre séparée
(voir [docs/notes.md](docs/notes.md)).

> LeakZero est une protection « au mieux ». Elle **ne garantit pas** l'absence de fuite :
> vérifiez toujours votre aperçu avant de diffuser (voir [Limitations](#limitations)).

## Stack
React 19, TypeScript, Vite, CRXJS, Tailwind CSS v4, shadcn/ui (Radix), Zod, libphonenumber-js, Tiptap et fflate
(module Notes), Vitest (+ jsdom).

## Démarrer
```bash
pnpm install
pnpm test
pnpm build
```
Charger `dist/` via `chrome://extensions` → Mode développeur → « Charger l'extension non empaquetée ».
Les onglets déjà ouverts sont protégés dès l'installation ou la mise à jour (voir
[Onglets déjà ouverts](#onglets-déjà-ouverts)).

## Fonctionnement
- **Numéros** : chaque nœud texte est analysé et seuls les nombres détectés sont remplacés ; le reste
  du message reste visible. Deux catégories sont distinguées (`src/detectors/numbers.ts`) :
  - **Téléphones** → `**********` flouté ; en **mode renforcé**, flou + rectangle noir opaque « 🛡 Numéro masqué »
    (`src/detectors/phone.ts`) :
    - internationaux avec `+` ou `00` : 8 à 15 chiffres séparés par espaces, `-`, `.` ou parenthèses
      (`+1 (202) 555-0123`), **valides ou non** (`+33000000000` est masqué) ;
    - indicatif sans `+` (`33 6 12 34 56 78`, `447911123456`) : classé téléphone si libphonenumber-js le
      valide, sinon masqué comme séquence générique ;
    - mobiles français `06`/`07`, quelle que soit la langue du navigateur, avec ou sans séparateurs
      (espace, espace insécable, `-`, `.`) ;
    - autres numéros nationaux pour les pays de `navigator.languages` (ex. `fr-FR` → FR).
    Une extension (`… ext. 1234`) n'est pas incluse dans le téléphone et suit la règle générique.
  - **Séquences génériques** → `•••` (`src/detectors/digits.ts`) : toute suite d'au moins 3 chiffres,
    même invalide comme téléphone (codes, références, numéros partiels). Les chiffres d'une même suite
    peuvent être séparés par un espace, une espace insécable, `-` ou `.` (ex. `123-456`, `12 34 56`).
    Les nombres de 1 ou 2 chiffres restent visibles.
  - **Exceptions** (restent visibles si la séquence est entièrement couverte) : dates (`12/05/2024`,
    `12.05.2024`, `2024-05-12`, jour/mois validés), heures (`14:30`, `12:30:45`, `14h30`), années
    seules (`1900`–`2099`), âges (`101 ans`, `102 years old`), prix et montants (`1 234,56 €`,
    `$1,299.99`, `250 EUR`, `120 k€`, `150 %`).
  - **Pas de masquage partiel** : toute suite de chiffres touchée par une détection est masquée en
    entier ; les détections qui se chevauchent sont fusionnées (téléphone si l'une d'elles en est un).
  - **Trois états** :
    | Numéros | Mode renforcé | Rendu |
    |---|---|---|
    | coupé | indifférent | texte original, aucun masquage |
    | activé | coupé | `**********` flouté |
    | activé | activé | flou **et**, par-dessus, rectangle noir opaque « 🛡 Numéro masqué » |

    Le switch « Mode renforcé » (désactivé par défaut) est grisé et sans effet quand les numéros sont coupés.
  - **Rendu des téléphones** :
    1. *Texte* (les deux modes) : le numéro est remplacé dans le nœud texte par `**********`, de
       longueur fixe (ne révèle pas celle du numéro). Aucun chiffre ne reste dans le texte affiché :
       si la couche visuelle est décalée, retirée ou absente, on ne voit que des astérisques. Le numéro
       original n'est gardé qu'en mémoire dans le content script, pour la restauration.
    2. *Flou* (les deux modes, `src/maskers/overlay.ts`) : une boîte `backdrop-filter: blur()` posée sur
       chaque ligne des astérisques. Rayon et marge sont proportionnels à la hauteur de ligne (¼ et ½) :
       mesuré dans Chromium, un rayon trop grand par rapport à la boîte rend le texte à nouveau lisible.
    3. *Rectangle* (mode renforcé) : boîte noire opaque couvrant les astérisques, libellé blanc
       « 🛡 Numéro masqué », dessinée au-dessus de tous les flous ; plus un highlight CSS
       (`::highlight(leakzero-phone-box)`, fond noir, glyphes transparents) dans le flux du texte, qui
       reste en place même quand la boîte a une frame de retard.

    Les couches 2 et 3 vivent dans un élément `<leakzero-overlay>` plein écran (`position: fixed`,
    `pointer-events: none`, `aria-hidden`, Shadow DOM fermé) ajouté à `<html>`, hors de l'arbre géré par
    React/Vue. Les positions viennent de `Range.getClientRects()`, recalculées à chaque frame
    (défilement, retour à la ligne, animation, redimensionnement), rognées par les conteneurs défilants et
    dessinées immédiatement à la détection. L'hôte n'a ni `contain`, ni `filter`, ni `opacity` : il
    deviendrait une « backdrop root » et le flou n'aurait plus rien à flouter.
  - **Changement de mode** : immédiat, sans réécriture du texte (les astérisques sont les mêmes dans les
    deux modes) : le numéro original n'est jamais remis dans le DOM pendant la transition. Un message
    détaché pendant le changement prend le mode courant à sa réinsertion.
  - Les séquences génériques sont remplacées par `•••`, sans flou ni rectangle.
  - Le nœud texte d'origine est conservé (seul son contenu change), ce qui évite de casser React/Vue, et
    le texte original est restauré exactement à la désactivation (sauf si la page l'a réécrit entre-temps).
- **Médias** : une feuille de style injectée dans le document et chaque Shadow DOM ouvert remplace le
  contenu des `img`, `video`, `input[type=image]` par un rectangle noir (`object-position` hors cadre),
  sans modifier la mise en page. Les médias ajoutés plus tard sont couverts par la même règle CSS.
  - **Exception Bitmoji** : une image reste visible seulement si sa source (`src` et chaque entrée de
    `srcset`) est servie en HTTPS par un domaine de rendu Bitmoji (`*.bitmoji.com`, ex.
    `sdk.bitmoji.com/render/panel/…`, ou l'ancien `render.bitstrips.com`), ou par le chemin de rendu
    d'avatars du CDN Snapchat : hôte exactement `cf-st.sc-cdn.net` **et** chemin commençant par
    `/3d/render/` (URL observées sur Snapchat Web). Le reste du CDN Snapchat reste masqué. Le domaine est vérifié via
    `URL`, pas par sous-chaîne ni par classe CSS. Une photo envoyée en conversation n'est jamais servie
    par ces domaines et reste masquée. Les images sont masquées par défaut jusqu'à leur classement, et
    reclassées si `src`/`srcset` changent ; une `img` dans `<picture>` reste toujours masquée.
- **Surveillance** : un `MutationObserver` (ajouts de nœuds + modifications de texte) déclenche une
  analyse `TreeWalker` du sous-arbre ajouté. Les mutations produites par LeakZero sont ignorées
  (`takeRecords()` + mémorisation du texte masqué) : pas de boucle.
- **Masquage préventif** : le script est injecté à `document_start` sous forme de script classique
  (sans chargeur asynchrone), active immédiatement tous les masquages (`FAIL_CLOSED`) puis applique les
  réglages enregistrés (même si toutes les protections sont coupées, le contenu présent avant leur
  lecture est donc brièvement masqué). Le traitement est synchrone dans le callback du `MutationObserver`, exécuté
  avant le rendu suivant.
- **Réglages** : le popup enregistre chaque changement immédiatement dans `chrome.storage.local` (pas de
  bouton « Enregistrer ») ; chaque content script écoute `chrome.storage.onChanged`, donc tous les onglets
  se mettent à jour immédiatement (voir [Modules](#modules) et [Stockage et migration](#stockage-et-migration)).
- **Confidentialité** : aucun contenu analysé n'est stocké, journalisé ni transmis.
- **Notes** : seul module qui ne protège pas ; il ne lit que l'identifiant (URL) et le nom de la
  conversation Snapchat ouverte, jamais les messages. Détails dans [docs/notes.md](docs/notes.md).

## Permissions
- `storage` : réglages.
- `scripting` + accès hôte `<all_urls>` (les mêmes sites que le content script, donc pas
  d'avertissement supplémentaire) : injection du content script dans les onglets déjà ouverts à
  l'installation et aux mises à jour.
- Un service worker, qui sert à l'installation et aux mises à jour (et aux commandes du module Notes) : initialiser/migrer le stockage
  (seul le navigateur sait distinguer une nouvelle installation d'une installation existante dont les
  réglages n'ont jamais été enregistrés), puis injecter la nouvelle version dans les onglets ouverts.
- Content script sur `<all_urls>`, `all_frames`, `match_about_blank` : nécessaire pour un fonctionnement
  générique (Chrome affiche donc l'avertissement « lire et modifier toutes vos données »).
- Aucune ressource web-accessible.
- Module Notes : aucune permission supplémentaire. Un second content script limité à
  `https://www.snapchat.com/web*` ; fenêtre (`chrome.windows`, sans permission) ; exports par
  téléchargement de lien (pas de permission `downloads`).

## Architecture
- `src/core/observer.ts` : `MutationObserver`, regroupement des mutations, anti-boucle.
- `src/core/scanner.ts` : orchestration (TreeWalker, Shadow DOM ouverts, application des réglages).
- `src/detectors/numbers.ts` : point d'entrée, combine téléphones et séquences génériques.
- `src/detectors/phone.ts` : téléphones (libphonenumber-js `max`, mobiles FR, indicatif nu).
- `src/detectors/digits.ts` : séquences de 3+ chiffres et exceptions.
- `src/detectors/range.ts` : utilitaires de plages de texte.
- `src/maskers/text.ts` : remplacement/restauration des numéros dans le texte, suivi des téléphones.
- `src/maskers/overlay.ts` : flou et rectangles « Numéro masqué » au-dessus des astérisques.
- `src/maskers/highlight.ts` : fond noir dans le flux du texte en mode renforcé.
- `src/maskers/styles.ts` : feuille de style LeakZero injectée dans le document et les Shadow DOM ouverts.
- `src/maskers/media.ts` : feuille de style de masquage des médias.
- `src/content/index.ts` : point d'entrée dans la page ; `src/content/protection.ts` : démarrage,
  lecture des réglages, relève d'une instance orpheline.
- `src/background/index.ts` : service worker (`onInstalled`) : initialisation/migration du stockage,
  puis injection de chaque content script dans les onglets ouverts que ses `matches` couvrent ; commandes
  du module Notes.
- `src/modules/` : modules de protection déclarés en YAML (voir [Modules](#modules)) :
  - `<id>/module.yaml` : déclaration ; `<id>/components/*.tsx` : composants React facultatifs ;
  - `schema.ts` : schéma Zod et validations croisées ; `registry.ts` : découverte, validation, tri ;
  - `conditions.ts` : `disabledWhen` / `visibleWhen` / `requires` ; `ui.ts` : icônes et composants (popup) ;
  - `icons.ts` : noms d'icônes Lucide (utilisé au build).
- `src/popup/` : interface. `App.tsx` (vues accueil / modules / paramètres avancés), `useStorage.ts`
  (synchronisation avec `chrome.storage.local`), `components/` (`ModuleAccordion`, `ModuleSettings`,
  `ModuleSearch`, `WelcomeScreen`, `AdvancedView`, `ResetModuleButton`). Composants shadcn/ui dans
  `src/components/ui/` (`Accordion`, `AlertDialog`, `Badge`, `Button`, `Input`, `Label`, `Select`,
  `Slider`, `Switch`, `Textarea`).
- `src/shared/keys.ts` : clés de stockage ; `settings.ts` : lecture des réglages par les content scripts ;
  `state.ts` : valeurs des modules, initialisation et migration.
- `src/notes/`, `src/content/notes.ts` : module Notes (service worker, détection Snapchat, fenêtre
  `src/notes/page/`) ; voir [docs/notes.md](docs/notes.md#architecture).
- `vite.config.ts` : plugin `leakzero-module-yaml` (YAML → JSON, validation au build, icônes utilisées).

## Popup
- **En-tête** : identité LeakZero et icône d'aide (rouvre l'écran d'accueil sans rien modifier).
  Pas d'interrupteur général : les modules sont indépendants.
- **Accordions** (ouverture multiple) : un par module, avec icône, titre, description, badge
  « Nouveau » éventuel, indicateur informatif `Actif`/`Inactif` et chevron. Tous les réglages, y compris
  l'interrupteur principal, sont à l'intérieur. Les sections ouvertes sont mémorisées (identifiants de
  modules, jamais d'indices) et restaurées à chaque ouverture du popup et au retour des paramètres avancés.
- **« Aucune protection active »** : avertissement discret, non bloquant, tant qu'aucune protection
  (numéros, médias) n'est active ; le module Notes n'en est pas une.
- **Notes** : bouton « Ouvrir Notes » dans son accordion quand le module est activé.
- **Recherche** : affichée à partir de 5 modules ; filtre par titre et description (sans casse ni accents),
  sans toucher aux réglages ni aux sections mémorisées, en conservant l'ordre.
- **Accueil** : affiché à la première utilisation (nouvelle installation) ; « Commencer » le mémorise.
  Les installations existantes ne le voient pas après la mise à jour.
- **Paramètres avancés** : lien dans l'accordion des modules qui en déclarent ; vue dédiée avec titre et
  flèche de retour, dans le popup. Le retour conserve sections ouvertes, réglages et défilement.
- **Réinitialiser ce module** : après confirmation (`AlertDialog`), remet les valeurs par défaut du module,
  protection coupée, en une seule écriture ; les autres modules ne changent pas.
- **Erreurs d'enregistrement** : message dans le popup, et la valeur réellement stockée est réaffichée.

## Modules
Un module = un dossier `src/modules/<id>/` contenant un `module.yaml`. Il n'y a rien d'autre à déclarer :
`import.meta.glob('./*/module.yaml')` (dans `registry.ts`) les découvre au build. Le YAML décrit les
réglages et leurs relations ; les algorithmes de protection restent en TypeScript et rien n'est exécuté
depuis le YAML (pas d'`eval`, pas d'import dynamique arbitraire).

### Format de `module.yaml`
```yaml
id: phone                      # kebab-case, stable, identique au nom du dossier
title: Numéros de téléphone
description: Masquage des numéros détectés   # facultatif
icon: phone                    # nom d'icône Lucide en kebab-case (lucide.dev)
order: 10                      # position dans le popup (égalité : tri par id)

settings:                      # réglages affichés dans l'accordion
  - id: enabled                # camelCase, unique dans le module
    type: switch
    label: Masquer les numéros
    description: …             # facultatif
    default: false
    primary: true              # interrupteur principal : exactement un, de type switch, sans dépendance

  - id: reinforced
    type: switch
    label: Mode renforcé
    default: false
    disabledWhen:
      setting: enabled
      equals: false

component: Summary             # facultatif : components/Summary.tsx, affiché sous les réglages

advanced:                      # facultatif : vue « Paramètres avancés »
  title: Rendu des numéros     # sous-titre de la vue (facultatif)
  settings: []                 # réglages déclaratifs de la vue (facultatif)
  component: AdvancedSettings  # components/AdvancedSettings.tsx (facultatif ; settings et/ou component)
```

### Types de réglages
| `type` | Champs propres | `default` |
|---|---|---|
| `switch` | — | booléen (obligatoire) |
| `select` | `options: [{ value, label }]` | une des `value` (obligatoire) |
| `slider` | `min`, `max`, `step` (1), `unit` | nombre dans `[min, max]` (obligatoire) |
| `input` | `placeholder`, `maxLength` | texte (`''`) |
| `textarea` | `placeholder`, `maxLength` | texte (`''`) |

Chaque type a son schéma (`schema.ts`) et son contrôle (`CONTROLS` dans
`src/popup/components/ModuleSettings.tsx`) : ajouter un type, c'est ajouter ces deux entrées.

### Dépendances déclaratives
- `disabledWhen: <condition>` : réglage grisé quand la condition est vraie ;
- `visibleWhen: <condition>` : réglage masqué quand la condition est fausse ;
- `requires: enabled` (ou une liste) : réglage grisé tant que ces switches ne sont pas activés.

Une condition est `{ setting, equals }`, `{ all: [conditions] }` ou `{ any: [conditions] }`, sur les
réglages du même module. Griser ou masquer ne change jamais la valeur mémorisée. Sont refusés : référence
inconnue, valeur comparée invalide pour le type du réglage (option inexistante, booléen attendu…),
`requires` vers autre chose qu'un switch, dépendances circulaires (y compris sur soi-même).

### Validation
Clés inconnues (fautes de frappe), types, valeurs par défaut, identifiants (format, doublons, dossier),
interrupteur principal, dépendances, icône et fichiers de composants sont vérifiés :
- **au build** (`pnpm build`, `pnpm dev`) par le plugin `leakzero-module-yaml`, qui échoue avec le chemin du
  fichier et la liste des problèmes ;
- **à l'exécution et en test** par `buildRegistry` (`ModuleConfigError`), qui refuse aussi les identifiants
  de module dupliqués.

### Composants React personnalisés
Quand un formulaire déclaratif ne suffit pas, le module nomme un composant (`component` ou
`advanced.component`) ; il est cherché uniquement dans `src/modules/<id>/components/<Nom>.tsx` (export par
défaut), découvert par `import.meta.glob` dans `ui.ts`. Il reçoit `{ module, values, setValue }`
(`ModuleComponentProps`) : valeurs courantes du module et enregistrement immédiat d'un de ses réglages.
Exemple : `src/modules/phone/components/AdvancedSettings.tsx` (aperçu du rendu dans le mode courant).

### Créer un module (exemple minimal)
```yaml
# src/modules/email/module.yaml
id: email
title: Adresses e-mail
description: Masquage des adresses détectées
icon: mail
order: 30
settings:
  - id: enabled
    type: switch
    label: Masquer les adresses
    default: false
    primary: true
```
Le module apparaît dans le popup, désactivé et marqué « Nouveau » pour les installations existantes.
Pour qu'il protège réellement, son moteur (détection/masquage) doit être branché côté content script :
ajouter le champ dans `ProtectionSettings` (`src/shared/types.ts`), sa clé dans `PROTECTION_FIELDS`
(`src/shared/settings.ts`) et son application dans `src/core/scanner.ts`.

## Stockage et migration
`chrome.storage.local`, une clé par réglage (aucune écriture n'a besoin de relire puis réécrire un objet
partagé, donc deux popups ne peuvent pas écraser leurs changements respectifs) :
| Clé | Contenu |
|---|---|
| `protection:<module>.<réglage>` | valeur d'un réglage (lue par les content scripts) |
| `ui:openSections` | identifiants des accordions ouverts |
| `ui:onboarded` | accueil effectué |
| `ui:newModules` | modules ajoutés par une mise à jour et pas encore ouverts (« Nouveau ») |
| `schemaVersion` | `1` une fois le stockage initialisé/migré |
| `settings` | ancien format `{ maskPhones, reinforcedPhones, maskMedia }`, lu pour la migration, jamais modifié |

- **Initialisation** (`planInitialization` dans `src/shared/state.ts`) : exécutée par le service worker à
  l'installation et à chaque mise à jour, puis par le popup à son ouverture. Elle est idempotente et
  appliquée en une seule écriture atomique.
- **Nouvelle installation** (raison `install` sans ancienne clé `settings`) : toutes les protections sont
  coupées (numéros, mode renforcé, médias), écran d'accueil à la première ouverture, aucun badge.
- **Installation existante** (pas de `schemaVersion`) : l'ancienne clé `settings` est recopiée avec les
  anciennes valeurs par défaut (numéros et médias activés, mode renforcé coupé), valeur par valeur ; une
  installation qui n'avait jamais rien enregistré garde donc exactement les protections qu'elle avait.
  Le mode renforcé est conservé, rien n'est réactivé ni désactivé, l'accueil n'est pas imposé, aucun
  badge sur les modules existants. Tant que la migration n'a pas eu lieu, les content scripts lisent
  l'ancienne clé (aucune fenêtre sans protection pendant la mise à jour).
- **Module ajouté par une mise à jour** : interrupteur principal coupé (quel que soit son `default`
  YAML), autres réglages à leur valeur par défaut YAML, badge « Nouveau » jusqu'à la première ouverture
  de son accordion (persistant). Les préférences des autres modules ne changent pas.
- **Réglage ajouté à un module existant** : valeur par défaut YAML ; les valeurs stockées ne sont jamais
  écrasées. Une valeur stockée invalide est lue comme la valeur par défaut.
- **Synchronisation** (`src/popup/useStorage.ts`) : mise à jour optimiste, écriture immédiate, pas
  d'écriture si la valeur n'a pas changé ; les changements venant d'autres contextes (autre popup, service
  worker) arrivent par `chrome.storage.onChanged`. Pendant une écriture, les événements de cette clé sont
  ignorés puis la clé est relue, ce qui évite les échos obsolètes et rattrape une écriture concurrente ou en
  échec. Le popup n'écrit jamais en réaction à un événement (pas de boucle).
- **Retour arrière** : l'ancienne clé `settings` étant conservée, une version précédente retrouverait les
  réglages d'avant la migration (pas ceux modifiés depuis).

## Onglets déjà ouverts
Chrome n'injecte pas les content scripts dans les onglets déjà ouverts, et lors d'un rechargement ou
d'une mise à jour de l'extension il **n'arrête pas** l'ancien content script : celui-ci reste actif dans
la page (observateur, masques, rectangles « Numéro masqué ») mais ne reçoit plus aucun changement de
réglage. Sans relève, désactiver une protection dans le popup n'avait donc aucun effet dans ces onglets,
et les nouveaux messages continuaient d'être masqués avec les anciens réglages.

À l'installation et à chaque mise à jour, le service worker migre le stockage puis injecte la version
courante dans tous les onglets et frames accessibles. Au démarrage, chaque instance émet l'événement DOM
`leakzero:takeover` ; une instance **orpheline** (dont `chrome.runtime.id` a disparu) restaure alors le
texte, retire ses calques et s'arrête, et la nouvelle instance masque de nouveau dans la même tâche :
aucun chiffre n'est affiché pendant la relève. Une instance encore connectée ignore cet événement, donc
une page ne peut pas désactiver la protection en l'émettant.

## Limitations
- **Onglets ouverts sous une version antérieure à la relève** (avant l'ajout de `leakzero:takeover`) :
  l'ancien script ne sait pas s'arrêter et continue de masquer avec ses anciens réglages ; recharger ces
  onglets une fois. Idem si l'extension est désactivée ou désinstallée : les onglets ouverts restent
  masqués (comportement sûr) jusqu'à leur rechargement.
- **Téléphones** : flou et rectangle sont appliqués *après* la détection et n'ajoutent aucune protection
  avant celle-ci. Lors d'un défilement rapide ou d'une animation, le flou peut avoir une frame de retard :
  des astérisques non floutés peuvent alors apparaître brièvement, jamais de chiffres. Les éléments de la
  « top layer » (`<dialog>` modal, popover, plein écran) passent au-dessus de la couche (astérisques
  visibles, sans flou). Sans `backdrop-filter`, le mode classique affiche les astérisques sous un voile gris.
  Les astérisques forment un seul mot : un numéro qui passait à la ligne peut se placer différemment.
- **Contenu envoyé à la plateforme** : les champs de saisie et zones `contenteditable` ne sont jamais
  modifiés. En revanche, une page qui relirait le texte *affiché* d'un message (ex. pour pré-remplir une
  modification ou une citation) obtiendrait `**********` / `•••`.
- **Flash avant masquage** : réduit mais pas exclu. Le contenu présent avant l'exécution du script, un
  rendu effectué entre deux tâches du parseur, ou une page lente à traiter peuvent être brièvement
  visibles. Les réglages sont chargés de façon asynchrone (protection active par défaut entre-temps).
- **Iframes** : le script est injecté dans les frames `http(s)`, `about:blank` et `srcdoc`, mais pas dans
  les frames `blob:`/`data:` ni les frames sandboxées sans origine.
- **Canvas / WebGL, images CSS** (`background-image`), `<svg><image>`, `<object>`/`<embed>` : non masqués.
  L'audio des vidéos n'est pas coupé.
- **Shadow DOM** : les racines fermées sont inaccessibles ; les racines ouvertes ne sont découvertes
  que lorsque leur hôte est inséré ou analysé (une racine attachée plus tard à un hôte déjà présent
  n'est pas vue).
- **Texte non couvert** : champs `input`/`textarea`, zones `contenteditable` (volontairement ignorées pour
  ne pas corrompre la saisie), attributs (`title`, `alt`, `placeholder`), contenu CSS `::before/::after`,
  titre de l'onglet, et numéros découpés sur plusieurs nœuds texte : dans `06 12 <b>34 56 78</b>`,
  chaque morceau est analysé séparément (ici `06 12` et `34 56 78` sont masqués comme séquences génériques,
  mais `06 <b>12</b>` laisse les deux morceaux visibles).
- **Détection** :
  - le masquage générique cache aussi des nombres anodins (compteurs, scores, numéros de version,
    adresses IP, codes postaux) : c'est voulu, au prix de faux positifs visibles ;
  - inversement, les exceptions laissent passer des nombres sensibles déguisés en date, année
    (`2024` comme code PIN), heure, âge ou montant ;
  - un numéro coupé par un autre caractère (`/`, `,`, lettres) ou écrit en lettres (`zéro six…`) est
    découpé en morceaux ; seuls les morceaux d'au moins 3 chiffres sont masqués (`06/12/34/56/78`
    ressemble par ailleurs à une date : seule la partie non couverte est masquée) ;
  - les numéros nationaux étrangers non couverts par libphonenumber-js sont masqués comme séquences
    génériques, pas comme téléphones.
- **Bitmoji** : l'exception repose sur les URL observées (`cf-st.sc-cdn.net/3d/render/…`) et sur les
  domaines Bitmoji documentés par des projets communautaires. Si Snapchat change d'hôte ou de chemin, les
  avatars redeviennent masqués (comportement sûr par défaut) : ajuster `SNAPCHAT_AVATAR` / `AVATAR_HOST`
  dans `src/maskers/media.ts`. Tout contenu que Snapchat servirait un jour sous `/3d/render/` (ex.
  stickers Bitmoji) resterait visible.
- Une feuille de style de la page avec des règles `!important` plus spécifiques, ou un style en ligne
  `!important`, peut annuler le masquage des médias.
