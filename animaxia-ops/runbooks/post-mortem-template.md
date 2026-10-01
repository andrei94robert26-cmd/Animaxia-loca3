# Template Post-Mortem — Animaxia 2.0 (PLAN 100X)

> Se completează pentru orice incident cu impact public (buget SLO consumat ≥ 25%,
> 502/503 publice, regresie într-o suită de validare). Onestete maximă: fără
> acoperiri, fără vina pe „circumstanțe" — doar fapte măsurate.

## Incident #[NNN] — [titlu scurt]
- **Severitate:** SEV-1 / SEV-2 / SEV-3
- **Început detectare:** [UTC] · **Rezolvare:** [UTC] · **Durată:** [min]
- **Impact public:** [utilizatori/requests afectate, căi]
- **Buget SLO consumat:** [%] (sursa: `public/slo-status.json` / istoric slo-history.jsonl)

## Cronologie (doar fapte cu timestamps)
| Timp (UTC) | Eveniment | Sursă (alertă/log/suită) |
|---|---|---|
| | | |

## Cauza de bază (root cause)
[Ce anume a picat și DE CE — lanț cauzal complet, verificat, nu presupus.]

## Ce a funcționat (apărări care au ținut)
[Failover, cache, rate-limit, sonde, suite — ce a limitat impactul.]

## Ce nu a funcționat
[Detectare lentă? alertă lipsă? runbook lipsă? acțiune manuală greșită?]

## Acțiuni corective
| # | Acțiune | Tip | Owner | Fază plan | Stare |
|---|---|---|---|---|---|
| 1 | | prevenție/detecție/mitigare | | | |

## Lecții pentru PLAN 100X
[Ce componentă nouă/test/process ar fi prins asta — se adaugă în faza următoare.]

## Dovada rezolvării
[Suita de regresie rulată + rezultat (ex: faza28-e-verify 40/40) + verificare browser.]

---
**Reguli:** componentele protejate (FAZA 18/20/21/23/24/25/28, Neon FTS, 30B,
pipeline, hub, player, AI Hub/Home) NU se modifică în remediere — doar straturi
aditive; orice excepție cere aprobarea explicită a utilizatorului (poarta ⚠️).
