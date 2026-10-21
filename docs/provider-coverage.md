# Provider coverage: ours vs woob and Cozy konnectors

Generated 2026-10-21 by `scripts/coverage-diff.mjs`. Re-run the script to refresh it.

Sources: our `providers/*.json`; woob modules under `modules/` in gitlab.com/woob/woob that declare `CapDocument` or `CapBill`; non-archived `cozy-konnector-*` repos in the `konnectors` GitHub org (template excluded).

Only names, URLs and metadata are read from upstream. No upstream code is copied here: woob is LGPL and Cozy konnectors are AGPL, which cannot be combined with this MIT project. The country column is a guess from the provider host TLD, then from nationality words in the description.

## Summary

- Our providers: **20**
- woob modules with CapDocument/CapBill: **59**
- Cozy konnectors (non-archived, excluding template): **26**, of which use cozy-clisk: **10**
- Ours also in woob: **1**; also in Cozy: **0**; also in cozy-clisk: **0**
- Ours with no match in woob or Cozy: **19**
- Providers in woob or Cozy but not ours: **74** (woob only: 48, Cozy only: 16, both: 10)

### Ours with no match upstream

- CodeRabbit
- Elastic Cloud
- GitHub
- GitHub Enterprise
- Google Cloud
- Google Workspace
- Hetzner
- Holded
- Hover
- Lowi
- Naturgy
- OpenAI
- Shortcut
- Stripe
- Twilio
- Vonage/TokBox
- Vultr
- Webflow
- ZeroSSL

### Present upstream but not ours

- Ameli (woob + Cozy, cozy-clisk)
- CESU (woob + Cozy, cozy-clisk)
- Orange (woob + Cozy, cozy-clisk)
- Payfit (woob + Cozy, cozy-clisk)
- Enercoop (woob + Cozy)
- Free Internet (woob + Cozy)
- Free Mobile (woob + Cozy)
- Materiel.net (woob + Cozy)
- Pajemploi (woob + Cozy)
- Trainline (woob + Cozy)
- Bouygues Telecom (Cozy, cozy-clisk)
- Harmonie Mutuelle (Cozy, cozy-clisk)
- MGEN (Cozy, cozy-clisk)
- Oui.sncf (Cozy, cozy-clisk)
- Sosh (Cozy, cozy-clisk)
- Total Energies (Cozy, cozy-clisk)
- abeilleassurances (woob)
- amelipro (woob)
- april (woob)
- axabanque (woob)
- bnp (woob)
- bnppere (woob)
- boursorama (woob)
- bouygues (woob)
- bp (woob)
- bred (woob)
- caissedepargne (woob)
- capeasi (woob)
- ccf (woob)
- cic (woob)
- cityscoot (woob)
- creditdunordpee (woob)
- creditmutuel (woob)
- deliveroo (woob)
- edfparticulier (woob)
- edfprofessionnel (woob)
- ekwateur (woob)
- ensap (woob)
- erehsbc (woob)
- esalia (woob)
- espacecitoyens (woob)
- federalfinancees (woob)
- franceconnect (woob)
- hellobank (woob)
- impotsgouvfrpar (woob)
- infomaniak (woob)
- ing (woob)
- ladresse (woob)
- lampiris (woob)
- lcl (woob)
- ldlc (woob)
- lucca (woob)
- milleis (woob)
- myfoncia (woob)
- nrjmobile (woob)
- onlinenet (woob)
- ovh (woob)
- poivy (woob)
- primonialreim (woob)
- s2e (woob)
- scaleway (woob)
- societegenerale (woob)
- sohappy (woob)
- ticketscesu (woob)
- Bouygues Box (Cozy)
- cozy-konnector-extension (Cozy)
- Digiposte (Cozy)
- Facebook (Cozy)
- Generali (Cozy)
- Google (Cozy)
- Maif - Echeancier (Cozy)
- Malakoff Mederic (Cozy)
- Numéricable (Cozy)
- The Old Reader (Cozy)

## Table

| Provider | Ours | woob | Cozy | cozy-clisk | Country (guess) | Source license |
| --- | --- | --- | --- | --- | --- | --- |
| Amazon | yes | `amazon` | - | - | Spain (TLD .es) | MIT (ours); woob: LGPLv3+ |
| CodeRabbit | yes | - | - | - | Global (.ai host) | MIT (ours) |
| Elastic Cloud | yes | - | - | - | Global (.co host) | MIT (ours) |
| GitHub | yes | - | - | - | Global (.com host) | MIT (ours) |
| GitHub Enterprise | yes | - | - | - | Global (.com host) | MIT (ours) |
| Google Cloud | yes | - | - | - | Global (.com host) | MIT (ours) |
| Google Workspace | yes | - | - | - | Global (.com host) | MIT (ours) |
| Hetzner | yes | - | - | - | Global (.com host) | MIT (ours) |
| Holded | yes | - | - | - | Global (.com host) | MIT (ours) |
| Hover | yes | - | - | - | Global (.com host) | MIT (ours) |
| Lowi | yes | - | - | - | Spain (TLD .es) | MIT (ours) |
| Naturgy | yes | - | - | - | Spain (TLD .es) | MIT (ours) |
| OpenAI | yes | - | - | - | Global (.com host) | MIT (ours) |
| Shortcut | yes | - | - | - | Global (.com host) | MIT (ours) |
| Stripe | yes | - | - | - | Global (.com host) | MIT (ours) |
| Twilio | yes | - | - | - | Global (.com host) | MIT (ours) |
| Vonage/TokBox | yes | - | - | - | Global (.com host) | MIT (ours) |
| Vultr | yes | - | - | - | Global (.com host) | MIT (ours) |
| Webflow | yes | - | - | - | Global (.com host) | MIT (ours) |
| ZeroSSL | yes | - | - | - | Global (.com host) | MIT (ours) |
| Ameli | - | `ameli` | `ameli` | yes | France (TLD .fr) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| CESU | - | `cesu` | `cesu` | yes | France (TLD .fr) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| Orange | - | `orange` | `orange` | yes | France (TLD .fr) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| Payfit | - | `payfit` | `payfit` | yes | Global (.com host) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| Enercoop | - | `enercoop` | `enercoop` | no | France (TLD .fr) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| Free Internet | - | `free` | `free` | no | France (TLD .fr) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| Free Mobile | - | `freemobile` | `free-mobile` | no | France (TLD .fr) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| Materiel.net | - | `materielnet` | `materielnet` | no | Global (.net host) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| Pajemploi | - | `pajemploi` | `pajemploi` | no | France (TLD .fr) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| Trainline | - | `trainline` | `trainline` | no | France (TLD .fr) | woob: LGPLv3+; Cozy: AGPL-3.0 |
| Bouygues Telecom | - | - | `bouyguestelecom` | yes | France (TLD .fr) | Cozy: AGPL-3.0 |
| Harmonie Mutuelle | - | - | `harmonie` | yes | France (TLD .fr) | Cozy: AGPL-3.0 |
| MGEN | - | - | `mgen` | yes | France (TLD .fr) | Cozy: AGPL-3.0 |
| Oui.sncf | - | - | `sncf` | yes | Global (.com host) | Cozy: AGPL-3.0 |
| Sosh | - | - | `sosh` | yes | France (TLD .fr) | Cozy: AGPL-3.0 |
| Total Energies | - | - | `directenergie` | yes | France (TLD .fr) | Cozy: AGPL-3.0 |
| abeilleassurances | - | `abeilleassurances` | - | - | Unknown | woob: LGPLv3+ |
| amelipro | - | `amelipro` | - | - | France (description) | woob: LGPLv3+ |
| april | - | `april` | - | - | Unknown | woob: LGPLv3+ |
| axabanque | - | `axabanque` | - | - | Unknown | woob: LGPLv3+ |
| bnp | - | `bnp` | - | - | Unknown | woob: LGPLv3+ |
| bnppere | - | `bnppere` | - | - | Unknown | woob: LGPLv3+ |
| boursorama | - | `boursorama` | - | - | Unknown | woob: LGPLv3+ |
| bouygues | - | `bouygues` | - | - | Unknown | woob: LGPLv3+ |
| bp | - | `bp` | - | - | Unknown | woob: LGPLv3+ |
| bred | - | `bred` | - | - | Unknown | woob: LGPLv3+ |
| caissedepargne | - | `caissedepargne` | - | - | Unknown | woob: LGPLv3+ |
| capeasi | - | `capeasi` | - | - | Unknown | woob: LGPLv3+ |
| ccf | - | `ccf` | - | - | France (description) | woob: LGPLv3+ |
| cic | - | `cic` | - | - | Unknown | woob: LGPLv3+ |
| cityscoot | - | `cityscoot` | - | - | Unknown | woob: LGPLv3+ |
| creditdunordpee | - | `creditdunordpee` | - | - | Unknown | woob: LGPLv3+ |
| creditmutuel | - | `creditmutuel` | - | - | Unknown | woob: LGPLv3+ |
| deliveroo | - | `deliveroo` | - | - | Unknown | woob: LGPLv3+ |
| edfparticulier | - | `edfparticulier` | - | - | Unknown | woob: LGPLv3+ |
| edfprofessionnel | - | `edfprofessionnel` | - | - | Unknown | woob: LGPLv3+ |
| ekwateur | - | `ekwateur` | - | - | Unknown | woob: LGPLv3+ |
| ensap | - | `ensap` | - | - | Unknown | woob: LGPLv3+ |
| erehsbc | - | `erehsbc` | - | - | Unknown | woob: LGPLv3+ |
| esalia | - | `esalia` | - | - | Unknown | woob: LGPLv3+ |
| espacecitoyens | - | `espacecitoyens` | - | - | Unknown | woob: LGPLv3+ |
| federalfinancees | - | `federalfinancees` | - | - | Unknown | woob: LGPLv3+ |
| franceconnect | - | `franceconnect` | - | - | France (description) | woob: LGPLv3+ |
| hellobank | - | `hellobank` | - | - | Unknown | woob: AGPLv3+ |
| impotsgouvfrpar | - | `impotsgouvfrpar` | - | - | Unknown | woob: LGPLv3+ |
| infomaniak | - | `infomaniak` | - | - | Unknown | woob: LGPLv3+ |
| ing | - | `ing` | - | - | France (description) | woob: LGPLv3+ |
| ladresse | - | `ladresse` | - | - | Unknown | woob: LGPLv3+ |
| lampiris | - | `lampiris` | - | - | France (description) | woob: LGPLv3+ |
| lcl | - | `lcl` | - | - | Unknown | woob: LGPLv3+ |
| ldlc | - | `ldlc` | - | - | Unknown | woob: LGPLv3+ |
| lucca | - | `lucca` | - | - | Unknown | woob: LGPLv3+ |
| milleis | - | `milleis` | - | - | Unknown | woob: LGPLv3+ |
| myfoncia | - | `myfoncia` | - | - | Unknown | woob: LGPLv3+ |
| nrjmobile | - | `nrjmobile` | - | - | Unknown | woob: LGPLv3+ |
| onlinenet | - | `onlinenet` | - | - | Unknown | woob: LGPLv3+ |
| ovh | - | `ovh` | - | - | Unknown | woob: LGPLv3+ |
| poivy | - | `poivy` | - | - | Unknown | woob: LGPLv3+ |
| primonialreim | - | `primonialreim` | - | - | Unknown | woob: LGPLv3+ |
| s2e | - | `s2e` | - | - | Unknown | woob: LGPLv3+ |
| scaleway | - | `scaleway` | - | - | Unknown | woob: LGPLv3+ |
| societegenerale | - | `societegenerale` | - | - | Unknown | woob: LGPLv3+ |
| sohappy | - | `sohappy` | - | - | Unknown | woob: LGPLv3+ |
| ticketscesu | - | `ticketscesu` | - | - | Unknown | woob: LGPLv3+ |
| Bouygues Box | - | - | `bouyguesbox` | no | France (TLD .fr) | Cozy: AGPL-3.0 |
| cozy-konnector-extension | - | - | `extension` | no | Unknown | Cozy: MIT |
| Digiposte | - | - | `digiposte` | no | France (TLD .fr) | Cozy: AGPL-3.0 |
| Facebook | - | - | `facebook` | no | Global (.com host) | Cozy: AGPL-3.0 |
| Generali | - | - | `generali` | no | France (TLD .fr) | Cozy: AGPL-3.0 |
| Google | - | - | `google` | no | Global (.com host) | Cozy: AGPL-3.0 |
| Maif - Echeancier | - | - | `echeancier-maif` | no | France (TLD .fr) | Cozy: AGPL-3.0 |
| Malakoff Mederic | - | - | `malakoffmederic` | no | Global (.com host) | Cozy: AGPL-3.0 |
| Numéricable | - | - | `numericable` | no | France (TLD .fr) | Cozy: AGPL-3.0 |
| The Old Reader | - | - | `theoldreader` | no | Global (.com host) | Cozy: AGPL-3.0 |
