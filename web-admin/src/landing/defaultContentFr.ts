// Contenu français de la page d'accueil (utilisé lorsque la langue = FR) — marchés francophones (Maghreb)
export const defaultContentFr = {
  cta: { tryFree: 'Démarrez votre essai gratuit' },
  hero: {
    badge: 'Plateforme de gestion des ventes terrain',
    titleLine1: 'Pilotez vos commerciaux terrain',
    titleLine2: 'de la commande à l’encaissement',
    subtitle: 'Une solution tout-en-un qui relie vos commerciaux de distribution au back-office en temps réel — commandes, factures fiscales, encaissement, reçus et rapports précis, au même endroit.',
    ctaSecondary: 'Voir la démo',
  },
  features: {
    title: 'Tout ce dont les équipes de distribution ont besoin, sur une seule plateforme',
    subtitle: 'De la création d’une commande sur le terrain au rapport qui arrive sur le bureau du responsable — tout est connecté et synchronisé.',
    items: [
      { title: 'Gestion des commandes terrain', desc: 'Le commercial crée la commande depuis son mobile avec le catalogue produits et les prix, qui parvient instantanément au bureau et à l’entrepôt.' },
      { title: 'Encaissement des paiements', desc: 'Enregistrez les paiements en espèces, par virement ou par chèque, et suivez en temps réel les soldes dus et en retard de chaque client.' },
      { title: 'Factures fiscales', desc: 'Émettez des factures fiscales conformes (ZATCA en Arabie saoudite) avec code QR, et envoyez-les directement au client.' },
      { title: 'Bons de reçu', desc: 'Un reçu numérique certifié pour chaque encaissement — envoyé au client et enregistré automatiquement dans son relevé.' },
      { title: 'Rapports et relevés', desc: 'Un relevé détaillé par client, ainsi que des rapports de performance des commerciaux, des ventes et de l’encaissement en un clic.' },
      { title: 'Commerciaux et autorisations', desc: 'Créez des comptes commerciaux et contrôlez finement les autorisations de chacun : remises, vente en dessous du prix, ajout de clients et plafond de remise.' },
      { title: 'Stock du véhicule', desc: 'Le commercial enregistre ce qu’il a chargé dans son véhicule par article ; le stock se décrémente automatiquement à chaque vente, et la direction suit le reliquat et les mouvements de marchandises (ce qui est sorti et quand) en temps réel.' },
      { title: 'Suivi GPS des commerciaux', desc: 'Suivez la position en direct des commerciaux sur la carte et l’itinéraire quotidien de chacun via GPS pendant leur travail sur le terrain.' },
      { title: 'Clients et relevés de compte', desc: 'Une base clients organisée avec plafonds de crédit, soldes et relevé détaillé par client — mise à jour automatiquement à chaque facture et paiement, avec alerte en cas de dépassement du plafond de crédit.' },
      { title: 'Catalogue produits et tarifs', desc: 'Un catalogue produits unifié avec tarifs dégressifs par quantité et prix spéciaux par client, transmis au commercial sur le terrain en temps réel.' },
      { title: 'Équipe et rôles de l’entreprise', desc: 'Ajoutez des utilisateurs (responsable, superviseur, comptable) avec des autorisations précises par section — chaque membre voit et fait uniquement ce que vous autorisez.' },
      { title: 'Intégration ERP', desc: 'Synchronisez vos clients, produits, factures et reçus avec votre système ERP via une connexion sécurisée, avec des journaux de synchronisation détaillés.' },
      { title: 'Classification par canal de vente', desc: 'Classez vos clients par canal de vente (commerce moderne, gros, commerce traditionnel, discounters, vente cash, e-commerce) et analysez les ventes par canal et par région.' },
      { title: 'Scan de codes-barres', desc: 'Scannez les codes-barres des produits avec la caméra du mobile du commercial pour ajouter les articles à la facture rapidement et précisément sur le terrain.' },
      { title: 'Fonctionne hors ligne', desc: 'L’application du commercial fonctionne toute la journée sans internet : émettez et imprimez factures fiscales et reçus avec code QR et remettez-les aux clients, puis chaque document est téléversé automatiquement au bureau dès le retour de la connexion — sans doublon ni perte de données.' },
      { title: 'Retours intelligents (endommagé/échange)', desc: 'Créez des retours classés (normal/endommagé/échange), avec contrôle par l’admin du retour ou non au stock du véhicule, et une politique de réintégration par produit.' },
    ],
  },
  how: {
    title: 'Démarrez en quelques minutes',
    subtitle: 'Trois étapes vous séparent d’une gestion complète de votre équipe terrain.',
    steps: [
      { title: 'Créez votre compte', desc: 'Enregistrez votre entreprise et ajoutez vos produits, clients et commerciaux en quelques minutes.' },
      { title: 'Les commerciaux partent en tournée', desc: 'Chaque commercial visite ses clients, crée les commandes et encaisse les paiements depuis son mobile.' },
      { title: 'Suivez et analysez', desc: 'Surveillez les ventes, l’encaissement et la performance en temps réel depuis un tableau de bord unique.' },
    ],
  },
  roles: {
    title: 'Une interface conçue pour chaque rôle',
    items: [
      { title: 'Commercial terrain', desc: 'Une application mobile légère : clients, commandes, encaissement et factures fiscales — directement depuis le téléphone.' },
      { title: 'Responsable des ventes', desc: 'Un tableau de bord complet pour suivre les équipes, les objectifs, l’encaissement et la performance de chaque commercial.' },
      { title: 'Direction', desc: 'Des rapports exécutifs et des indicateurs de croissance pour la prise de décision, sur toutes les agences et régions.' },
    ],
  },
  pricing: {
    title: 'Des offres qui grandissent avec votre entreprise',
    subtitle: 'Commencez gratuitement pendant 10 jours — sans carte bancaire.',
    plans: [
      { name: 'Débutant', price: '299', limit: 'Jusqu’à 5 commerciaux · 1 utilisateur admin' },
      { name: 'Croissance', price: '399', limit: 'Jusqu’à 10 commerciaux · 2 utilisateurs admin' },
      { name: 'Professionnel', price: '599', limit: 'Jusqu’à 20 commerciaux · 5 utilisateurs admin', badge: 'Le plus demandé' },
      { name: 'Entreprise', price: 'Sur devis', limit: 'Commerciaux illimités' },
    ],
  },
  faq: {
    title: 'Questions fréquentes',
    items: [
      { q: 'Les factures sont-elles conformes à la réglementation ?', a: 'Le système émet des factures fiscales simplifiées avec code QR selon la Phase 1 (génération) de la facturation électronique. La Phase 2 (intégration) n’est pas encore disponible, et la ZATCA ne certifie pas les éditeurs de logiciels. Les paramètres de taxe s’adaptent au pays de l’entreprise.' },
      { q: 'Ai-je besoin de matériel spécifique ?', a: 'Non — l’application fonctionne sur n’importe quel smartphone. Pour l’impression sur le terrain, une imprimante thermique 58 mm (Bluetooth ou intégrée) suffit.' },
      { q: 'L’application fonctionne-t-elle hors ligne ?', a: 'Oui — l’application du commercial fonctionne toute la journée sans internet : émettez et imprimez factures fiscales et reçus avec code QR et remettez-les aux clients, puis chaque document est téléversé automatiquement au bureau dès le retour de la connexion, sans doublon ni perte de données.' },
      { q: 'Combien de temps prend la configuration ?', a: 'Vous pouvez configurer votre entreprise, vos produits et vos commerciaux en quelques minutes et commencer à émettre des factures immédiatement.' },
      { q: 'Puis-je essayer le système avant de souscrire ?', a: 'Oui, contactez-nous à info@fieldsa.net et nous vous aiderons à essayer le système avant de souscrire.' },
    ],
  },
  finalCta: {
    title: 'Prêt à doubler l’efficacité de votre équipe terrain ?',
    subtitle: 'Émettez vos factures fiscales, encaissez vos paiements et suivez votre équipe terrain — le tout depuis une seule plateforme.',
    ctaSecondary: 'Réserver une démo',
    note: '10 jours gratuits · Sans carte bancaire · Annulable à tout moment',
  },
  footer: {
    desc: 'Une plateforme complète pour gérer les ventes terrain de distribution — de la commande à l’encaissement.',
  },
  contact: {
    intro: 'Nous sommes là pour vous aider. Contactez-nous et nous vous répondrons dans les meilleurs délais.',
    email: 'info@fieldsa.net',
    phone: '',
    whatsapp: '',
    address: 'Arabie saoudite',
  },
  pages: {
    about: {
      title: 'À propos',
      body: 'Field Sales est une plateforme complète de gestion des commerciaux de distribution sur le terrain — de la création d’une commande jusqu’à l’émission de la facture fiscale, l’encaissement des paiements et le reporting. Nous aidons les entreprises de distribution à gérer leurs équipes terrain avec une efficacité et une transparence totales, dans les pays arabes et francophones.',
    },
    terms: {
      title: 'Conditions générales',
      body: `Dernière mise à jour : juillet 2026

Les présentes Conditions générales régissent votre utilisation de la plateforme FieldSales. En créant un compte ou en utilisant la plateforme, vous reconnaissez avoir lu et accepté ces Conditions. Si vous ne les acceptez pas, veuillez ne pas utiliser le service.

1. Définitions
« Plateforme » : le service FieldSales, ses applications et son site fieldsa.net. « Abonné » : l’entreprise titulaire du compte. « Utilisateur » : toute personne utilisant la plateforme pour le compte de l’Abonné (responsable, utilisateur ou commercial terrain).

2. Description du service
La plateforme est un système cloud de gestion des commerciaux de distribution sur le terrain, comprenant : gestion des commandes, factures fiscales, encaissement et bons de reçu, gestion des clients et des produits, stock du véhicule, suivi des commerciaux et rapports.

3. Compte et inscription
• Vous vous engagez à fournir des informations exactes et à jour lors de l’inscription.
• Vous êtes responsable de la confidentialité de vos identifiants et de toute activité effectuée via votre compte.
• Vous devez nous informer immédiatement de toute utilisation non autorisée de votre compte.

4. Essai gratuit et abonnement
• Nous offrons un essai gratuit de 10 jours, sans carte bancaire.
• À l’issue de l’essai, la poursuite du service nécessite un abonnement payant selon l’offre choisie.
• Les prix peuvent évoluer à l’avenir moyennant un préavis, sans incidence sur une période déjà réglée.

5. Utilisation acceptable
Vous vous engagez à ne pas :
• Utiliser la plateforme à des fins illicites ou en violation des réglementations applicables.
• Tenter de pirater, perturber ou accéder sans autorisation aux données de tiers.
• Effectuer de l’ingénierie inverse, copier ou revendre le service sans autorisation écrite.
• Saisir des données portant atteinte aux droits, à la vie privée ou à la propriété intellectuelle de tiers.

6. Propriété des données
Les données de l’Abonné (ses clients, produits, factures et registres) restent sa propriété exclusive. L’Abonné nous accorde une licence limitée pour traiter ces données uniquement dans la mesure nécessaire au fonctionnement du service.

7. Facturation électronique et conformité fiscale
La plateforme vous aide à émettre des factures fiscales conformes aux exigences de l’autorité compétente (par exemple ZATCA en Arabie saoudite). La responsabilité de l’exactitude des données fiscales et de la conformité à la réglementation de facturation du pays d’exploitation incombe à l’Abonné.

8. Propriété intellectuelle
Tous les droits relatifs à la plateforme, ses logiciels, ses conceptions et sa marque appartiennent à FieldSales et ne peuvent être utilisés en dehors du cadre autorisé du service.

9. Disponibilité et support
Nous mettons en œuvre des efforts raisonnables pour maintenir la disponibilité du service et fournir un support via info@fieldsa.net et help@fieldsa.net. Nous pouvons effectuer une maintenance périodique avec préavis dans la mesure du possible.

10. Suspension et résiliation
Nous pouvons suspendre ou résilier un compte en cas de violation des présentes Conditions ou de non-paiement, tout en offrant une possibilité raisonnable d’exporter les données, sauf interdiction légale.

11. Exclusion de garantie
Le service est fourni « en l’état ». Nous ne garantissons pas qu’il sera totalement exempt d’interruptions ou d’erreurs, tout en nous engageant à faire preuve de la diligence professionnelle requise.

12. Limitation de responsabilité
Nous ne sommes pas responsables des dommages indirects, consécutifs ou de perte de bénéfices. En tout état de cause, notre responsabilité ne dépassera pas le total des frais d’abonnement payés au cours des trois mois précédant la réclamation.

13. Indemnisation
L’Abonné accepte d’indemniser FieldSales de toute réclamation ou tout dommage découlant de son utilisation de la plateforme en violation des présentes Conditions ou de la loi applicable.

14. Modifications des Conditions
Nous pouvons modifier ces Conditions de temps à autre et publier la version mise à jour sur cette page ; la poursuite de l’utilisation vaut acceptation.

15. Droit applicable et litiges
Les présentes Conditions sont régies par la législation applicable dans le pays d’exploitation du service. Les litiges sont réglés à l’amiable dans la mesure du possible, à défaut devant les autorités compétentes.

16. Contact
Pour toute question : info@fieldsa.net`,
    },
    serviceAgreement: {
      title: 'Contrat de service',
      body: `Dernière mise à jour : juillet 2026

Ce contrat décrit l’étendue du service FieldSales, son niveau de prestation et les obligations des deux parties. Il complète les « Conditions générales ».

1. Étendue du service
Le service comprend l’accès à la plateforme cloud FieldSales et à ses composants selon votre offre d’abonnement : gestion des commandes, factures fiscales, encaissement et bons de reçu, gestion des clients et des produits, stock du véhicule, suivi des commerciaux et rapports — avec l’application mobile du commercial.

2. Niveau de disponibilité
Nous nous efforçons de maintenir une haute disponibilité du service 24h/24. Des interruptions temporaires peuvent survenir en raison de la maintenance ou de causes indépendantes de notre volonté (fournisseurs d’infrastructure ou réseaux). Nous vous informons des maintenances planifiées à l’avance dans la mesure du possible.

3. Support technique
Nous fournissons un support par e-mail : info@fieldsa.net pour les demandes générales et help@fieldsa.net pour le support technique. Nous nous efforçons de répondre dans un délai raisonnable les jours ouvrés.

4. Sauvegarde et continuité des données
Nous effectuons des sauvegardes régulières des données de la plateforme dans le cadre de nos procédures de reprise, afin de protéger vos données contre la perte autant que possible.

5. Sécurité et isolation des données
Les données de chaque abonné sont stockées dans un espace isolé, les connexions sont chiffrées et des contrôles précis d’autorisations s’appliquent. (Voir la « Politique de confidentialité » pour plus de détails.)

6. Mises à jour et développement
Nous développons continuellement la plateforme et ajoutons régulièrement des fonctionnalités et améliorations, sans nuire à vos fonctions essentielles.

7. Responsabilités de l’Abonné
• Saisir des données exactes et garder confidentiels les comptes de ses utilisateurs et commerciaux.
• Utiliser le service de manière licite et se conformer à la réglementation du pays d’exploitation.
• Veiller à l’exactitude de ses factures et de ses données fiscales et financières.

8. Limites d’utilisation
Le service est soumis aux limites de l’offre (nombre de commerciaux et d’utilisateurs) et à une politique d’usage équitable, afin de garantir la qualité du service pour tous les abonnés.

9. Export des données à la résiliation
À la résiliation de l’abonnement, une possibilité raisonnable vous est offerte d’exporter vos données avant leur suppression, conformément à la politique de conservation applicable.

10. Modification du contrat
Nous pouvons mettre à jour ce contrat pour servir le développement du service, en publiant la version mise à jour sur cette page.

11. Contact
info@fieldsa.net`,
    },
    privacy: {
      title: 'Politique de confidentialité',
      body: `Dernière mise à jour : septembre 2026

FieldSales (« nous », « la plateforme ») s’engage à protéger la vie privée de ses clients, de ses utilisateurs et des visiteurs de son site. La présente politique explique quelles données nous collectons, comment nous les utilisons et les protégeons, avec qui nous les partageons, ainsi que les droits dont vous disposez en vertu de la loi saoudienne sur la protection des données personnelles (PDPL).

1. Qui sommes-nous
La plateforme FieldSales est exploitée par « مؤسسة تكامل الميدان للتجارة والإستيراد », immatriculée au registre du commerce sous le n° 7040371671 et établie à Riyad, Royaume d’Arabie saoudite. Elle est l’entité responsable des traitements de données personnelles décrits dans la présente politique.
Les données d’exploitation qu’une entreprise abonnée saisit dans son compte sont traitées pour le compte de cette entreprise et uniquement afin de lui fournir le service.

2. Champ d’application
La présente politique s’applique à tous les utilisateurs de la plateforme (entreprises abonnées, leurs responsables et utilisateurs, commerciaux terrain), aux visiteurs de notre site fieldsa.net, à toute personne qui nous contacte sur WhatsApp, via notre formulaire de contact ou notre formulaire de demande d’abonnement, ou par e-mail, aux ambassadeurs FieldSales, à toute personne qui effectue un paiement via un lien de paiement en ligne de la plateforme, ainsi qu’aux entreprises que nous contactons à des fins marketing.

3. Données que nous collectons
• Données de compte : nom de l’entreprise, nom d’utilisateur, e-mail, numéro de téléphone et mot de passe (stocké chiffré).
• Données d’exploitation saisies par l’entreprise : clients, produits, prix, commandes, factures, bons de reçu et soldes de comptes.
• Données de géolocalisation (GPS) issues de l’application du commercial, comme décrit à la section 11.
• Données techniques : type d’appareil, adresse IP et journaux d’utilisation, à des fins de sécurité et de performance, ainsi que les heures d’ouverture et de connexion de l’application du commercial, à partir desquelles ses heures de travail sont calculées pour son entreprise, comme décrit à la section 11.
• Données de navigation sur le site public et de mesure publicitaire, décrites aux sections 5 et 6.
• Données des conversations WhatsApp lorsque vous nous écrivez, décrites à la section 8.
• Données du formulaire de contact et du formulaire de demande d’abonnement de notre site, et des messages que vous envoyez à notre adresse e-mail : nom, nom de l’entreprise, e-mail, numéro de mobile, pays, ville, nombre de commerciaux et texte du message ou remarques.
• Données de paiement en ligne, lorsqu’un abonnement ou une facture est réglé via un lien de paiement : le montant, la description du paiement (comme le nom de l’entreprise et le numéro de facture), le numéro de mobile pour une nouvelle demande d’abonnement faite sur WhatsApp, ainsi que le statut et la référence du paiement auprès de notre prestataire de passerelle de paiement, Moyasar. Les données de carte sont saisies sur la page de paiement hébergée par Moyasar : elles ne transitent donc pas par nos serveurs et nous ne les stockons pas.
• Données des ambassadeurs FieldSales : nom, e-mail, numéro de mobile, ville, mot de passe (stocké chiffré), numéro et date d’expiration de la licence Mawthooq et numéro de TVA (le cas échéant), coordonnées bancaires pour le versement des rémunérations (IBAN stocké chiffré, nom du titulaire et nom de la banque) et une valeur dérivée de l’adresse IP lors de l’acceptation des conditions du programme ; ainsi que les données des entreprises qu’ils recommandent : nom de l’entreprise, numéro de registre du commerce, ville, numéro de contact, manière dont l’ambassadeur connaît l’entreprise et sa note.
• Données des intégrations que l’entreprise abonnée active avec les clés de son propre compte auprès de leurs prestataires, comme Hatif pour les numéros professionnels (nous recevons les numéros professionnels et les journaux d’appels : numéros des deux parties, heure, durée, lien de l’enregistrement chez le prestataire, ainsi que la transcription et le résumé si le prestataire les transmet) et PetroApp (nous recevons les véhicules de l’entreprise et leurs immatriculations, les noms et numéros de téléphone de ses chauffeurs, ainsi que les factures de carburant, d’entretien et de lavage), ou encore un système ERP dont l’entreprise définit l’adresse (nous lui envoyons, à la demande de l’entreprise, ses clients, y compris leurs noms, numéros de téléphone, adresses et positions sur la carte, ainsi que ses produits, ses factures, y compris le nom et le numéro de téléphone du commercial, et ses bons de reçu). Nous traitons ces données pour le compte de l’entreprise et selon ses instructions, comme indiqué à la section 1.
• Coordonnées professionnelles publiquement accessibles des entreprises que nous contactons à des fins marketing, décrites à la section 4.
• Données des factures que vous créez avec le générateur de factures gratuit de notre site, décrites à la section 4.

4. Comment nous utilisons vos données
Nous utilisons les données uniquement pour :
• Exploiter la plateforme et vous fournir ses services.
• Assurer le support technique et communiquer au sujet de votre compte.
• Répondre à vos demandes avant et après votre abonnement.
• Gérer le programme d’ambassadeurs FieldSales, calculer et verser les rémunérations des ambassadeurs.
• Contacter des entreprises à des fins marketing, comme décrit ci-dessous.
• Savoir quels canaux et quelles pages nous amènent des visiteurs, et mesurer et améliorer l’efficacité de nos annonces.
• Améliorer la performance et la sécurité et prévenir les abus.
• Respecter les obligations légales et réglementaires.
Nous n’utilisons jamais les données d’exploitation stockées dans les comptes des entreprises abonnées à des fins publicitaires, et nous ne vendons aucune donnée à qui que ce soit.
Le traitement des données de compte et des données d’exploitation repose sur l’exécution du contrat d’abonnement et le respect de nos obligations légales ; celui des données de paiement, sur l’exécution du paiement que vous demandez ; et celui des données des ambassadeurs, sur l’exécution des conditions du programme d’ambassadeurs. Les bases légales des statistiques de visite, de la mesure publicitaire et des conversations WhatsApp sont indiquées dans leurs sections respectives.
Nous collectons, auprès de sources publiques telles que les cartes, les annuaires professionnels, les moteurs de recherche et les sites web des entreprises elles-mêmes, ainsi qu’auprès de prestataires de cartographie, de recherche et de données d’entreprises, des coordonnées professionnelles publiquement accessibles sur des entreprises : nom de l’entreprise, activité, téléphone, e-mail, site web, adresse, ville, pays et position sur la carte. Nous les utilisons pour contacter ces entreprises à des fins marketing par e-mail et WhatsApp, et nous enregistrons leurs interactions avec nos messages, comme l’ouverture des e-mails, les clics sur leurs liens, les réponses et les demandes d’arrêt des messages. Toute entreprise, et toute personne concernée par ces données, peut s’y opposer et demander l’arrêt de nos contacts : le lien de désabonnement de nos e-mails arrête nos e-mails, une réponse à un message WhatsApp par un mot d’arrêt arrête nos messages WhatsApp, et pour arrêter tout contact sur l’ensemble des canaux, écrivez à info@fieldsa.net.
Lorsque vous téléchargez ou imprimez une facture depuis le générateur de factures gratuit de notre site, nous conservons le nom de l’entreprise vendeuse, son numéro de TVA, son adresse et son pays, le nom de l’acheteur et son numéro de TVA, ainsi que le montant total et la devise de la facture, et nous enregistrons l’entreprise vendeuse comme prospect. Nous utilisons ces données pour améliorer le service et contacter l’entreprise vendeuse à des fins marketing. Ces données sont saisies par l’utilisateur de l’outil et ne sont pas publiquement accessibles. L’entreprise vendeuse peut s’y opposer et demander à ne pas être contactée par les moyens décrits ci-dessus.

5. Statistiques de visite du site public
Lorsque vous naviguez sur notre site public fieldsa.net (et non dans la plateforme après connexion), nos serveurs enregistrent pour chaque page visitée :
• L’adresse de la page, sa langue et le site référent, le cas échéant.
• Le type de navigateur et d’appareil, tel que transmis par votre navigateur.
• Le pays, la région et la ville approximatifs, obtenus en transmettant votre adresse IP à un service externe de géolocalisation IP.
• Une valeur dérivée de votre adresse IP par une fonction de hachage, que nous conservons à la place de l’adresse elle-même ; depuis septembre 2026, nous la dérivons avec une clé secrète. Cette valeur est identique pour chaque visite depuis la même adresse IP ; nous l’utilisons donc pour estimer le nombre de visiteurs uniques.
• Les balises de campagne présentes dans le lien de la visite, telles que utm_source, utm_medium et utm_campaign.
• Un identifiant visiteur anonyme et aléatoire, un identifiant de session qui expire après 30 minutes d’inactivité, ainsi que la source de votre première visite issue d’une campagne ou d’un site externe, avec la première page consultée.
Ces identifiants sont conservés dans le stockage local (localStorage) de votre navigateur, et non dans des cookies, jusqu’à ce que vous les effaciez ou arrêtiez la mesure avec le bouton décrit à la section 7. Ces enregistrements ne contiennent ni votre nom, ni votre adresse e-mail, ni votre numéro de téléphone, et nous n’utilisons pas d’empreinte d’appareil (fingerprinting).
Lorsque vous appuyez sur un bouton WhatsApp de notre site, nous enregistrons cet appui, la page d’origine et votre identifiant visiteur (le cas échéant), et nous ajoutons au message prérempli un court code de référence commençant par « FS ». Si vous envoyez le message avec ce code, nous l’utilisons pour relier votre conversation et votre numéro de téléphone à votre historique de navigation sur notre site depuis le même navigateur, à la source de votre première visite et à la campagne qui vous a amené. Vous pouvez supprimer le code avant l’envoi ; ce rapprochement n’a alors pas lieu.
Si vous arrivez via un lien de parrainage d’un ambassadeur FieldSales, nous conservons le code de parrainage dans votre navigateur afin que votre abonnement puisse être attribué à cet ambassadeur lors de votre inscription. Nous cessons d’en tenir compte 365 jours après son enregistrement et le supprimons de votre navigateur lors de votre première visite sur notre site après ce délai.
Nous utilisons ces données pour savoir quels canaux et quelles pages génèrent des visites et des conversations. Leur conservation est décrite à la section 13.
Base légale : notre intérêt légitime à comprendre la performance de notre site et de nos canaux marketing, tout en préservant votre droit de vous opposer à cette mesure et de l’arrêter par les moyens indiqués à la section 7.

6. Mesure publicitaire avec Google Ads
Nous diffusons des annonces dans les résultats de recherche Google et utilisons la balise Google Ads fournie par Google LLC uniquement sur notre site public (et non dans la plateforme après connexion). Elle sert à mesurer si une visite issue de nos annonces a abouti au démarrage d’un essai gratuit ou d’une conversation WhatsApp avec nous.
Cette mesure implique le traitement :
• De l’identifiant de clic publicitaire que Google ajoute au lien de l’annonce.
• Des pages de notre site public sur lesquelles la balise s’exécute.
• De l’événement de conversion lui-même (démarrage d’un essai gratuit ou d’une conversation WhatsApp).
• De données techniques traitées directement par Google, telles que votre adresse IP et les informations sur votre navigateur et votre appareil.
À cette fin, Google dépose des cookies internes (first-party) sur notre domaine, tels que _gcl_au et _gcl_aw.
Nos engagements pour cette mesure :
• Nous avons désactivé les signaux de personnalisation des annonces dans les paramètres de la balise.
• Nous ne créons pas d’audiences de remarketing.
• Nous n’importons pas de listes de clients chez Google, nous n’activons pas la fonctionnalité de conversions améliorées (Enhanced Conversions) dans Google Ads et nous ne transmettons pas intentionnellement à Google votre nom, votre adresse e-mail ou votre numéro de téléphone.
Finalité : mesurer l’efficacité de nos annonces et orienter nos dépenses publicitaires.
Base légale : notre intérêt légitime à mesurer la performance de nos annonces avec le minimum de données nécessaire, tout en préservant votre droit de vous opposer à cette mesure et de l’arrêter à tout moment par les moyens indiqués à la section 7.
Google peut traiter ces données sur des serveurs situés hors du Royaume d’Arabie saoudite, conformément à sa propre politique de confidentialité : https://policies.google.com/privacy

7. Comment arrêter la mesure
• Le bouton « Arrêter la mesure » en bas de cette page (fieldsa.net/privacy) : il arrête la mesure sur le navigateur que vous utilisez, de sorte que la balise Google Ads n’est plus chargée ; il supprime les cookies déposés par la balise sur le domaine fieldsa.net et efface les données d’attribution enregistrées dans le navigateur, comme l’identifiant visiteur, l’identifiant de session et la source de la première visite. Les cookies que Google dépose sur ses propres domaines se gèrent dans les paramètres de Google et votre compte Google. Vous pouvez reprendre la mesure avec le même bouton.
• Signaux de confidentialité du navigateur : si vous activez Do Not Track ou Global Privacy Control dans votre navigateur, nous le traitons comme un arrêt de la mesure.
• Blocage du stockage local : si votre navigateur empêche notre site d’accéder au stockage local, nous le traitons comme un arrêt de la mesure.
• Paramètres du navigateur : vous pouvez bloquer ou supprimer les cookies et effacer les données stockées par notre site. La suppression ou l’effacement n’arrête pas à lui seul la mesure : il retire les identifiants enregistrés ainsi que l’indicateur d’arrêt de la mesure enregistré par le bouton, et nous créons de nouveaux identifiants lors de votre prochaine visite, sauf si un signal de confidentialité est activé dans votre navigateur ou si le stockage local est bloqué.
Lorsque la mesure est arrêtée par l’un des trois premiers moyens, nous ne créons ni identifiant visiteur ni identifiant de session, nous n’enregistrons ni les balises de campagne ni la source de la première visite, nous ne chargeons pas la balise Google Ads, nous ne dérivons aucune valeur de votre adresse IP et nous ne la transmettons pas au service de géolocalisation.
Nous n’enregistrons alors que des statistiques de visite minimales (adresse et langue de la page, site référent, type de navigateur et d’appareil tel que transmis par votre navigateur), ainsi que les appuis sur un bouton WhatsApp avec leur code de référence, sans les relier à un identifiant visiteur.
L’arrêt de la mesure ne s’applique pas au code de parrainage, nécessaire au calcul des droits des ambassadeurs.
La page des paramètres publicitaires de Google (https://adssettings.google.com) gère la personnalisation des annonces que Google vous montre. Elle n’arrête pas la mesure des conversions sur notre site.

8. Conversations WhatsApp
Lorsque vous nous écrivez sur WhatsApp, vos messages peuvent recevoir la réponse d’un assistant automatisé fondé sur l’intelligence artificielle, qui rédige les réponses et vous les envoie automatiquement, sans relecture humaine préalable. La conversation est transmise à un membre de notre équipe lorsque votre demande nécessite une intervention humaine.
Nous traitons votre numéro de téléphone, votre nom d’affichage WhatsApp (le cas échéant) et le contenu de vos messages pour répondre à vos demandes et en assurer le suivi. Nous transmettons le texte de la conversation à des prestataires d’intelligence artificielle, tels qu’Anthropic et Google, qui le traitent pour notre compte afin de générer les réponses.
Si vous nous écrivez depuis le numéro de téléphone enregistré dans les paramètres d’une entreprise abonnée, nous utilisons ce numéro pour extraire un résumé du compte de l’entreprise (nom de l’entreprise, statut, formule et date d’expiration de l’abonnement, nombre de commerciaux) et, lorsque vous posez des questions sur les chiffres de votre compte, ses indicateurs d’activité du mois (nombre de factures, total des ventes et des encaissements, nombre de clients et de clients ayant un solde dû, dernière facture avec son numéro et son montant). Nous transmettons ce résumé à l’assistant automatisé et aux prestataires d’intelligence artificielle afin qu’il réponde à vos questions. À votre demande, nous effectuons aussi des actions limitées, comme réinitialiser le mot de passe d’un commercial, désactiver ou réactiver un commercial, ou créer un compte d’essai avec le nom et l’e-mail que vous nous communiquez, et nous vous envoyons dans la même conversation les noms et identifiants de connexion des commerciaux de l’entreprise, pour identifier le commercial concerné, ainsi que le mot de passe temporaire ou celui du nouveau compte.
Si votre premier message contient un code de référence FS, nous relions la conversation à votre historique de navigation sur notre site et à la campagne qui vous a amené, comme décrit à la section 5.
Base légale : la réponse à la demande que vous avez initiée en nous écrivant, et notre intérêt légitime à en assurer le suivi.
WhatsApp est lui-même soumis à la politique de confidentialité de Meta.

9. Isolation des données par entreprise
Les données de chaque entreprise abonnée sont stockées dans un espace logiquement isolé (isolation multi-locataire), de sorte qu’aucune entreprise ne peut accéder aux données d’une autre, et vos données restent votre propriété exclusive.

10. Partage des données et transferts hors du Royaume
Nous ne vendons pas vos données et ne les partageons avec des tiers que dans les cas suivants :
• Prestataires agissant pour notre compte, uniquement dans la mesure nécessaire au fonctionnement du service, notamment notre hébergeur cloud ; GitHub, où nous conservons des copies de sauvegarde périodiques de la base de données ; nos prestataires d’envoi, de réception et de transfert d’e-mails ; un service de géolocalisation IP ; un service cartographique qui nous sert à faire correspondre les itinéraires des commerciaux au réseau routier ; les prestataires d’intelligence artificielle utilisés pour répondre aux conversations WhatsApp ; Meta, qui exploite WhatsApp et par qui transitent les messages WhatsApp ; notre prestataire de passerelle de paiement, Moyasar ; et les prestataires de cartographie, de recherche et de données d’entreprises auprès desquels nous obtenons les coordonnées professionnelles des entreprises.
• Google LLC, pour la mesure publicitaire sur notre site public, comme décrit à la section 6, ainsi que lorsque votre navigateur charge depuis les serveurs de Google les polices de notre site et de la plateforme et les tuiles cartographiques des écrans de suivi des commerciaux ; Google reçoit alors votre adresse IP et la zone de carte affichée. L’arrêt de la mesure n’empêche pas le chargement de ces polices.
• Les prestataires des intégrations que l’entreprise abonnée active, avec lesquels nous échangeons des données à la demande de l’entreprise : nous recevons de Hatif et PetroApp les données décrites à la section 3, et nous envoyons les données des clients, des produits, des factures et des bons de reçu au système ERP dont l’entreprise définit l’adresse. Ce système peut être situé hors du Royaume, selon le choix de l’entreprise.
• En cas d’obligation légale ou de demande d’une autorité compétente.
La plateforme et sa base de données sont hébergées sur des serveurs situés dans le Royaume d’Arabie saoudite, et les données de la plateforme, y compris les données de compte, d’exploitation et de localisation, les statistiques de visite et les conversations WhatsApp, sont stockées sur ces serveurs. Aucune de ces données n’est traitée hors du Royaume, à l’exception de celles que nous transférons aux prestataires et entités mentionnés dans la présente section.
GitHub, nos prestataires d’e-mail, de géolocalisation, de cartographie, de recherche et de données d’entreprises et d’intelligence artificielle, ainsi que Meta et Google, sont situés hors du Royaume. Nous ne leur transférons que les données nécessaires à la fourniture du service et aux finalités décrites dans la présente politique.

11. Suivi de la géolocalisation
L’application du commercial collecte des données de localisation de deux manières :
• Suivi de l’itinéraire : il ne fonctionne que si le responsable de l’entreprise l’active, et il enregistre la position du commercial toutes les quelques secondes tant que celui-ci est connecté et que l’application est ouverte sur son appareil. L’application ne le limite pas aux heures de travail ; nous conseillons donc aux commerciaux de se déconnecter ou de fermer l’application en dehors des heures de travail. Le responsable de l’entreprise peut le désactiver à tout moment ; il est alors désactivé pour tous les commerciaux de l’entreprise.
• Une position ponctuelle, captée indépendamment du réglage de suivi, lorsque le commercial enregistre une visite terrain (comme preuve de passage, avec les photos de la visite) ou place la position d’un client sur la carte. L’application lit également la position actuelle, sans l’enregistrer, pour vérifier la proximité d’un client ou trouver les stations-service les plus proches.
Les points d’itinéraire sont transmis à un prestataire cartographique afin de les faire correspondre au réseau routier et de les afficher sur la carte.
L’application du commercial enregistre également ses heures d’ouverture et de connexion à nos serveurs tant que le commercial est connecté et que l’application est ouverte, indépendamment du réglage de suivi : la désactivation du suivi ne l’arrête donc pas. À partir de ces heures, des points d’itinéraire et des visites, les heures de travail du commercial ainsi que ses jours de présence et d’absence sont calculés et affichés à la direction de l’entreprise.
L’entreprise utilise ces données à des fins professionnelles, telles que l’organisation et la vérification des visites, l’amélioration de la couverture et la mesure des heures de travail. Nous les traitons pour le compte de l’entreprise abonnée et selon ses instructions, comme indiqué à la section 1.

12. Sécurité des données
Nous appliquons des mesures de protection techniques et organisationnelles : chiffrement des connexions entre votre navigateur ou application et nos serveurs (HTTPS), chiffrement des mots de passe et contrôle des autorisations. Malgré notre vigilance, aucun système n’est sûr à 100 %, aussi nous vous recommandons de protéger vos identifiants.

13. Conservation des données
Nous conservons les données de votre compte et vos données d’exploitation pendant la durée de votre abonnement et ne les supprimons pas automatiquement à son terme. À sa résiliation, vous pouvez demander l’export de vos données, puis leur suppression.
Nous n’avons pas encore fixé de durée de suppression automatique pour les statistiques de visite, les enregistrements d’appui sur les boutons WhatsApp et les conversations WhatsApp ; ils sont donc actuellement conservés sans suppression automatique.
Pour demander la suppression de votre compte ou de toute donnée vous concernant, écrivez à help@fieldsa.net, comme l’explique la page fieldsa.net/delete-account/. Nous procédons à la suppression dans un délai de 30 jours à compter de la vérification de votre demande, à l’exception des données que la loi nous oblige à conserver, comme les factures fiscales et les documents comptables, que nous conservons pendant la durée légale. Si l’entreprise a passé des écritures comptables que la loi nous oblige à conserver, les données liées à ces écritures peuvent ne pas pouvoir être supprimées avant la fin de la durée légale ; dans ce cas, nous suspendons le compte et ne conservons ces données que pendant la durée légale. Des copies des données supprimées subsistent dans nos sauvegardes jusqu’à leur remplacement dans le cycle normal de sauvegarde.
L’identifiant visiteur, l’identifiant de session et la source de la première visite restent dans votre navigateur jusqu’à ce que vous les effaciez ou arrêtiez la mesure avec le bouton, comme décrit à la section 7.

14. Vos droits
La loi sur la protection des données personnelles vous garantit le droit :
• D’être informé des données que nous collectons à votre sujet, ainsi que des finalités et de la base légale de leur traitement, comme l’expose la présente politique.
• D’accéder à vos données, d’en obtenir une copie et de les exporter.
• De rectifier, compléter et mettre à jour vos données.
• De demander la suppression de vos données lorsqu’elles ne sont plus nécessaires.
• De vous opposer à la mesure publicitaire et de l’arrêter par les moyens indiqués à la section 7.
• De vous opposer à nos communications marketing et de demander leur arrêt, comme indiqué à la section 4.
• De retirer votre consentement à tout moment lorsque le traitement repose sur celui-ci.
Pour exercer l’un de ces droits, écrivez-nous à info@fieldsa.net ; pour les demandes de suppression, écrivez à help@fieldsa.net, comme indiqué à la section 13. Vous avez également le droit d’introduire une réclamation auprès de l’autorité compétente en matière de protection des données personnelles dans le Royaume.

15. Cookies et stockage local
• Cookies et données nécessaires au fonctionnement de la plateforme et à la conservation de votre session et de vos préférences.
• Identifiants de mesure internes, code de parrainage et indicateur d’arrêt de la mesure, conservés dans le stockage local, comme décrit aux sections 5 et 7.
• Cookies Google Ads, tels que _gcl_au et _gcl_aw, et les données que la balise peut conserver dans le stockage local, sur le site public pour mesurer les conversions, comme décrit à la section 6.
Nous n’utilisons pas de cookies pour personnaliser les annonces ni pour constituer des audiences de remarketing.

16. Vie privée des mineurs
La plateforme est destinée à un usage professionnel et ne doit pas être utilisée par des personnes de moins de 18 ans.

17. Modifications de la présente politique
Nous pouvons mettre à jour cette politique de temps à autre et publier la version mise à jour sur cette page avec la date de mise à jour.

18. Contact
Pour toute question relative à la confidentialité ou à vos données :
« مؤسسة تكامل الميدان للتجارة والإستيراد » (FieldSales), Riyad, Royaume d’Arabie saoudite
info@fieldsa.net`,
    },
  },
  social: { x: '', instagram: '', linkedin: '', whatsapp: '', snapchat: '', youtube: '', facebook: '', tiktok: '' },
};
