# PCC adapteri - NÜMUNƏ

Bu faylı öz repo-nda `<repo>/.claude/pcc.md` kimi saxla. Skill ilk işi olaraq onu oxuyur.

Adapter YALNIZ bu repo-ya aid olanı saxlayır: əmrlər, ölçülmüş vaxtlar, sağlamlıq yoxlamaları, bu repo-nun tələləri. Protokolun özü skill-dədir, buraya köçürmə.

Yoxdursa skill stack-i özü müəyyənləşdirir (`package.json`, `build.gradle*`, `pom.xml`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `Makefile`, CI konfiqi) və bu faylı yazır. Üçüncü dəfə eyni əmrləri yenidən kəşf etməmək üçün onu commit et.

---

## Əmrlər

```bash
# gate - hər commit qarşısında, saniyələr
<kompilyasiya əmri>          # məs. ./gradlew compileJava compileTestJava
<tip yoxlaması>              # məs. npx tsc --noEmit
<lint>                       # məs. npx eslint src --cache
<sürətli unit testlər>       # məs. npx tsx --test "src/**/*.test.ts"

# sweep - gün sonu
<servisləri qaldır>          # məs. ./scripts/dev-up.sh all
<tam test dəsti>             # məs. ./gradlew test
<e2e>                        # məs. npx playwright test
<təmiz build>                # məs. ./gradlew clean build
```

## Təmiz nöqtə

Sweep-in sahəsi son təmiz nöqtədən HEAD-ə qədərdir. Lokal git tag ilə işarələ:

```bash
git diff pcc-clean...HEAD --name-only     # sahə
git tag -f pcc-clean HEAD                 # sweep yaşıl olanda (push OLUNMUR)
```

Tag yoxdursa `origin/main...HEAD` işlət və bunu hesabatda de.

## Sağlamlıq yoxlamaları

Sweep-in "servislər həqiqətən işləyir" addımı üçün. Hər biri 200 qaytarmalıdır:

| Servis | URL | Qeyd |
|---|---|---|
| backend | `http://localhost:8080/actuator/health` | |
| frontend | `http://localhost:3000/` | ⚠️ redirect verən yolu YOX, son yolu yoxla - `curl -f` 3xx-i uğur sayır |

## Ölçülmüş vaxtlar

Dar/geniş qərarını rəqəmlə ver, hissiyyatla yox. Ölç, sonra yaz:

| Qapı | Dar | Geniş |
|---|---|---|
| lint | tək fayl, ~2 san | tam ağac, ~40 san |
| tip | per-file YOXDUR | ~40 san |
| unit | tək fayl | tam dəst, ~6 san |
| inteqrasiya | ad filtri, ~20 san | tam dəst, ~90 san |
| e2e | tək spec | tam suite - ara dövrədə HEÇ VAXT |

## Bu repo-nun tələləri

Buraya YALNIZ təkrar dəyən, bu repo-ya xas olanları yaz. Universal tələlər skill-in `troubleshooting.md`-sindədir.

- **`<alət>` problem tapanda da exit 0 verir** - çıxışı oxu, exit koduna baxma.
- **`<test dəsti>` təzyiq altında sükutla ilişir** - yoxlama: worker prosesləri + artefakt mtime.
- **Tanınan yük-flake specləri:** `<siyahı>` - adı burdadırsa və toxunmadığın koddursa, standalone yoxla.
- **Generasiya olunan fayllar:** `<siyahı>` - "ağac dəyişdi" yoxlamasından çıxarılmalıdır, çünki PCC-nin öz addımı onları yenidən yazır.
