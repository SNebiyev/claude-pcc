---
name: pcc
description: PCC (Pre Commit Check) protokolu - istənilən layihədə commit qapısı. "PCC", "full PCC", "PCC et", "gate", "sweep", "commit üçün hazırla" deyiləndə YÜKLƏ. İki tier, addımların sırası, sürət qaydaları (dar dövrə/geniş son), sübut qaydaları (artefakt oxu, exit kodu yox), verdikt və hesabat. PCC HEÇ VAXT commit etmir. Layihəyə xas əmrlər `<repo>/.claude/pcc.md` adapterindən gəlir.
---

# PCC - Pre Commit Check

Bu skill **protokoldur, əmr siyahısı deyil**. Layihəyə xas əmrlər, vaxtlar və tələlər adapterdədir.

## 0. Adapteri tap - ilk iş budur

```bash
cat .claude/pcc.md 2>/dev/null || echo "ADAPTER YOXDUR"
```

- **Adapter varsa** - əmrlər, tier tərkibi, sağlamlıq yoxlamaları və layihə tələləri oradadır. Bu fayl onların üstündəki qaydadır.
- **Adapter yoxdursa** - stack-i özün müəyyənləşdir (`package.json`, `build.gradle*`, `pom.xml`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `Makefile`, CI konfiqi), aşağıdakı qapı ailələrini həmin stack-in əmrlərinə uyğunlaşdır, sonra **`.claude/pcc.md`-ni yaz** - üçüncü dəfə eyni əmrləri yenidən kəşf etmə.

## Sıfırıncı qayda

🔴 **PCC commit ETMİR.** Yaşıl verdiktdən sonra dayan, hesabat ver, açıq göstərişi gözlə.

## İki tier

| Tier | Nə vaxt | Tərkib | Hədəf vaxt |
|---|---|---|---|
| **gate** | Hər commit | kompilyasiya + tip + lint + sürətli unit testlər | saniyələr - 2 dəq |
| **sweep** | Gün sonu / iş dəstəsi bağlananda | gate + servislərin həqiqətən qalxması + review skill-ləri + tam test dəsti + e2e + təmiz build | 15-40 dəq |

🔴 **"PCC" tək başına deyiləndə DEFAULT = SWEEP.** `gate` yalnız o söz deyiləndə. Soruşma.

🔴 **Sweep-in sahəsi son təmiz nöqtədən HEAD-ə qədər BÜTÜN commitlərdir**, son commit tək başına yox. Təmiz nöqtəni işarələməyin yolu bir lokal git tag-ıdır (məs. `pcc-clean`): sweep yaşıl olanda tag HEAD-ə sürüşür, növbəti sweep-in sahəsi `git diff pcc-clean...HEAD` olur. Adapter bunu avtomatlaşdıran əmri saxlayır. Tag yoxdursa `origin/main...HEAD` işlət və bunu hesabatda de.

## Sweep-in sırası - pozulmaz

1. **Sahəni oxu** - `git diff --name-only <təmiz-nöqtə>...HEAD`.
2. **Build + rerun** - kompilyasiya/tip/lint, sonra servisləri HƏQİQƏTƏN qaldır və canlı sağlamlıq yoxlaması et. "Kompilyasiya olundu" ≠ "işləyir".
3. **Düzəliş** - tapılanların hamısını **BİR dəstə** halında.
4. **`/security-review`** - yalnız deltaya.
5. **`/simplify`** - yalnız deltaya.
6. **`/code-review`** - yalnız deltaya.
7. **Testlər** - tam dəst + e2e.
8. **Son təmiz build** - `clean` ilə, çünki inkremental build keşdən yaşıl yalan verə bilər.

**Sıra niyə vacibdir:** kod əvvəl oturur, SONRA review skill-ləri, SONRA yekun build. Tərsi olsa hər düzəliş review-ları köhnəldir və dövrə sıfırdan başlayır.

Review skill-ləri git bazası istəyir - `origin/HEAD` təyin olunmayıbsa əvvəl `git remote set-head origin -a`.

## Sürət: dövrənin içində DAR, sonda BİR dəfə GENİŞ

Ara iterasiyada tam suite qaçırmaq xərcdir və heç nə sübut etmir - onsuz da sonda tam qaçış var. Qapı qırılanda **səbəbkar faylı düzəlt və yalnız o faylı yenidən yoxla**.

| Qapı | Ara iterasiya | Yalnız son pass |
|---|---|---|
| lint | tək fayl(lar) | tam ağac |
| tip yoxlaması | çox vaxt per-file variantı YOXDUR - tam qaçış, inkremental keşə güvən | tam qaçış |
| unit | tək test faylı | tam dəst (adətən onsuz da ucuzdur) |
| backend/inteqrasiya | ad filtri (`--tests "*Foo*"` və oxşarı) | tam dəst |
| e2e | TƏK spec → sonra qrup | tam suite - **ara dövrədə HEÇ VAXT** |

## Review skill-lərinə HƏR RAUNDDA yalnız o raundun deltasını ver

Sweep çox raunda uzananda bütün sahəni təkrar-təkrar oxutma. Real ölçü: yeddi raundluq sweep-də hər raund eyni 550 KB diffi yenidən oxudu, raund başına ~800 min token və 20+ dəqiqə, tapılanların demək olar hamısı əvvəlki raundlarda artıq baxılmış hissələrdə idi.

- Raund başlayanda `git diff --name-only` ilə həmin raundun toxunduğu faylları götür, skill arqumentində fayl-fayl sadala və yaz: **"SCOPE IS THESE N FILES ONLY - do NOT read the wider diff"**.
- Əvvəlki raundlarda tətbiq olunmuş və ya qəsdən təxirə salınmış tapıntıları **"DO NOT re-report"** siyahısı kimi ötür.
- Şərh/sənəd-only düzəliş üçün tam sıfırdan PCC çağırma.

## Kosmetik tapıntı dövrəni BAŞLATMIR

Dövrənin təkrarlanma səbəbi adətən məzmun deyil, mexanikadır: bir şərh sətrini düzəltsən ağac dəyişir, əvvəlki addımların sübutu köhnəlir, hər şey təkrar qaçır.

Tapıntını tətbiq etməzdən əvvəl soruş: **davranışı dəyişirmi?**

- **Bəli** → düzəlt, amma hamısını BİR dəstə et.
- **Xeyr** (yanlış şərh, istifadə olunmayan qaytarım, test helper-i) → borc siyahısına yaz və dövrəni BAĞLA.

Bir raund elan et ki, orada tapılan heç nə tətbiq olunmur, hamısı borca yazılır. Yoxsa hər düzəliş yeni raund doğurur. Bu, "hər tapıntını düzəlt" qaydası ilə ziddiyyət deyil - borc yazılır, atılmır.

## Fix-everything siyasəti

PCC-də tapılan hər şey düzəlir - toxunmadığın fayllardakı, köhnə commitlərdən qalan problemlər də. Həm error, həm warning. Lint son passda **tam ağac** üzərində qaçır, dəyişən fayllarda yox (`tail` kəsilməsi bir dəfə əlavə warning-ləri gizlətmişdi). Tək istisna yuxarıdakı kosmetik qaydadır.

## Sübut qaydaları

🔴 **Exit kodu sübut deyil.** Ölçülmüş nümunələr: `gradlew build | tail` 63 uğursuz testlə exit 0 verdi, `gofmt -l` problem tapanda da exit 0 verir. **Artefaktı oxu** - JUnit/JSON/TAP hesabatı, lint-in JSON çıxışı, test nəticə qovluğu.

🔴 **Artefakt TƏZƏ olmalıdır.** Köhnə test-nəticə faylı "pass" kimi oxunur. Addımın başlanğıc vaxtını saxla, artefaktın `mtime`-ı ondan böyük olmalıdır. UP-TO-DATE build sistemi (Gradle, Bazel, `make`) testi ümumiyyətlə qaçırmadan yaşıl görünə bilər.

🔴 **Qapının görmədiyi dil qapısız dildir.** Yeni dil/servis əlavə edəndə əvvəlcə PCC-nin onu həqiqətən QIRMIZI verdiyini neqativ kontrolla sübut et: kompilyasiya xətası, uğursuz test, format pozuntusu - üçü də ayrıca.

## Uzun addımı necə qaçırmalı

🔴 **Uzun qaçışı (tam test dəsti, e2e, təmiz build) harness taskının içində saxlama - reap olunur və bütün qaçış itir.** Prosesi ayır, gözləməni AYRICA apar:

```bash
nohup <uzun əmr> > "$LOG" 2>&1 < /dev/null &
PID=$!
disown
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 15; done
tail -40 "$LOG"        # qərarı ARTEFAKTDAN ver
```

Üç qayda, hər biri ölçülmüş bir asılı qalmadan gəlir:

1. **Gözləmə şərti prosesin canlılığıdır, mətn sentineli deyil.** Sentinel **nə baş verdiyini** deyir, **nə vaxt dayanmağı** yox - proses çöksə heç bir söz çap olunmur və sentinel-şərtli döngə saatlarla asılı qalır.
2. **Canlılığı `kill -0 $PID` ilə yoxla, `pgrep -f "<naxış>"` ilə YOX.** Döngənin öz əmr sətri həmin naxışı daşıyır, yəni `pgrep` özünü görür və şərt heç vaxt yalan olmur. (Ehtiyac olsa `pgrep -f "pcc[.]mjs"` kimi mötərizə fəndi işlədilir, amma PID sadədir və dəqiqdir.)
3. **Deadline məcburidir.** `seq 1 N` sayğacı olmayan döngə heç vaxt öz-özünə bitmir.

macOS-da `setsid` və `timeout` yoxdur - yuxarıdakı sayğac və ya `curl -m N` işlət.

## Verdikt qırmızı verəndə - əvvəl mühiti şübhələn

Ardıcıllıq `troubleshooting.md`-dədir: paralel sessiya artefaktları üstələyir, test icraçısı sükutla ilişir, e2e yük altında flake verir, iddia yenidən oxumur. Layihəyə xas tələlər adapterdədir.

## Hesabat

1. **Verdikt** - GREEN / RED, artefaktdan gələn rəqəmlərlə.
2. **Neçə raund oldu, hər raundda nə düzəldi** - fayl adları ilə.
3. **Borca yazılanlar** - harada saxlanılırsa orada, nömrələri ilə.
4. **Təsdiqlənməmiş və ya keçilmiş addım varsa AÇIQ de** - "GREEN" sözü tək başına onu gizlədir.
5. **Nəyi restart etmək lazımdır** - tam əmrlərlə. Heç nə lazım deyilsə bunu açıq de.
6. **Commit mesajı layihəsi** - amma commit ETMƏ.
