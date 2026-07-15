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
      { name: 'Débutant', price: '299', limit: 'Jusqu’à 5 commerciaux' },
      { name: 'Professionnel', price: '799', limit: 'Jusqu’à 20 commerciaux', badge: 'Le plus populaire' },
      { name: 'Entreprise', price: 'Sur devis', limit: 'Commerciaux illimités' },
    ],
  },
  faq: {
    title: 'Questions fréquentes',
    items: [
      { q: 'Les factures sont-elles conformes à la réglementation ?', a: 'Oui, le système émet des factures fiscales (Phase 2) conformes aux exigences de facturation électronique ZATCA, avec code QR. Les paramètres de taxe s’adaptent au pays de l’entreprise.' },
      { q: 'Ai-je besoin de matériel spécifique ?', a: 'Non — l’application fonctionne sur n’importe quel smartphone. Pour l’impression sur le terrain, une imprimante thermique 58 mm (Bluetooth ou intégrée) suffit.' },
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
      body: `Dernière mise à jour : juillet 2026

FieldSales (« nous », « la plateforme ») s’engage à protéger la vie privée de ses clients et utilisateurs. La présente politique explique les types de données que nous collectons, ainsi que la manière dont nous les utilisons et les protégeons lorsque vous utilisez notre plateforme de gestion des ventes terrain et de la distribution.

1. Champ d’application
La présente politique s’applique à tous les utilisateurs de la plateforme : entreprises abonnées, leurs responsables et utilisateurs, commerciaux terrain, et visiteurs de notre site fieldsa.net.

2. Données que nous collectons
• Données de compte : nom de l’entreprise, nom d’utilisateur, e-mail, numéro de téléphone et mot de passe (stocké chiffré).
• Données d’exploitation saisies par l’entreprise : clients, produits, prix, commandes, factures, bons de reçu et soldes de comptes.
• Données de géolocalisation (GPS) : collectées depuis l’application du commercial pendant les heures de travail uniquement, aux fins de suivi des visites et des itinéraires, et activées par le responsable de l’entreprise.
• Données techniques : type d’appareil, adresse IP et journaux d’utilisation, à des fins de sécurité et de performance.

3. Comment nous utilisons vos données
Nous utilisons les données exclusivement pour :
• Exploiter la plateforme et vous fournir ses services.
• Assurer le support technique et communiquer au sujet de votre compte.
• Améliorer la performance et la sécurité et prévenir les abus.
• Respecter les obligations légales et réglementaires.
Nous n’utilisons pas vos données à des fins publicitaires et ne les vendons à aucun tiers.

4. Isolation des données par entreprise
Les données de chaque entreprise abonnée sont stockées dans un espace logiquement isolé (isolation multi-locataire), de sorte qu’aucune entreprise ne peut accéder aux données d’une autre, et vos données restent votre propriété exclusive.

5. Partage des données
Nous ne partageons vos données avec des tiers que dans les cas suivants :
• Prestataires de confiance agissant pour notre compte (hébergement, envoi d’e-mails), et uniquement dans la mesure nécessaire au fonctionnement du service.
• En cas d’obligation légale ou de demande d’une autorité compétente.

6. Suivi de la géolocalisation
Le suivi du commercial est activé à la connaissance de l’entreprise, limité aux heures de travail et à des fins professionnelles (organisation des visites et amélioration de la couverture), et peut être configuré ou désactivé par commercial par l’entreprise.

7. Sécurité des données
Nous appliquons des mesures de protection techniques et organisationnelles : chiffrement des connexions (HTTPS), chiffrement des mots de passe et contrôle des autorisations. Malgré notre vigilance, aucun système n’est sûr à 100 %, aussi nous vous recommandons de protéger vos identifiants.

8. Conservation des données
Nous conservons vos données pendant la durée de votre abonnement. À sa résiliation, vous pouvez demander l’export de vos données, qui sont ensuite supprimées conformément à notre politique dans un délai raisonnable, sauf obligation légale de conservation.

9. Vos droits
Vous avez le droit d’accéder à vos données, de les rectifier, de les exporter et d’en demander la suppression en nous contactant à info@fieldsa.net.

10. Cookies
Nous utilisons des cookies nécessaires au fonctionnement de la plateforme et à la conservation de votre session et de vos préférences. Nous n’utilisons pas de traceurs publicitaires.

11. Vie privée des mineurs
La plateforme est destinée à un usage professionnel et ne doit pas être utilisée par des personnes de moins de 18 ans.

12. Modifications de la présente politique
Nous pouvons mettre à jour cette politique de temps à autre et publier la version mise à jour sur cette page avec la date de mise à jour.

13. Contact
Pour toute question relative à la confidentialité ou à vos données : info@fieldsa.net`,
    },
  },
  social: { x: '', instagram: '', linkedin: '', whatsapp: '', snapchat: '', youtube: '', facebook: '', tiktok: '' },
};
