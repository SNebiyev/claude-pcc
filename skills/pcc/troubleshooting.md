# PCC qırmızı verəndə - əvvəl bunları keç

Universal tələlər. Layihəyə xas olanlar `<repo>/.claude/pcc.md`-dədir.

## 1. Uzun addım "reap" olundu, kod qüsuru deyil

Uzun və səssiz qaçış (tam e2e, tam test dəsti) harness taskının içində öldürülür. Heartbeat çap etmək kifayət etmir - reaper task QRUPUNU tutur, səssizliyi yox. Tək işləyən forma `SKILL.md`-nin "Uzun addımı necə qaçırmalı" bölməsindədir: `nohup … & disown` + ayrıca canlılıq döngəsi.

İz: log yarımçıq kəsilib, prosess yoxdur, heç bir xəta yazılmayıb.

## 2. Uydurma qırmızı: paralel sessiya artefaktları üstələyib

Əksər PCC skriptləri artefaktlarını sabit yola yazır (`/tmp/<layihə>-pcc/` və oxşarı) - sessiya və ya işçi ağac üzrə ayrılmır. İki agent sessiyası eyni repoda işləyəndə ikincinin qaçışı birincinin log-larını sükutla üstələyir.

İz: yekun cədvəl `fail=1` deyir, log faylını açanda uğursuz sətir ümumiyyətlə yoxdur - sübut mövcud deyil.

**Yoxlama - iddiadan ƏVVƏL:**
```bash
stat -f '%Sm' <log-yolu>        # macOS
stat -c '%y' <log-yolu>         # Linux
```
Log sənin qaçışının başlanğıcından ƏVVƏLdirsə və ya SONRAdırsa (başqa qaçış yazıb), onu oxumaq mənasızdır. Qapını öz izolyasiya olunmuş fayluna yenidən qaç.

⚠️ Paralel sessiya PCC qaçırarkən PCC skriptinin ÖZÜNƏ toxunma - onun qaçışını sındırarsan.

## 3. Test icraçısı sükutla ilişir

Böyük test dəsti resurs təzyiqi altında ilişə bilər: build daemon-u BUSY göstərir, heç bir worker prosesi qalmır, log 20+ dəqiqə dəyişmir, CPU 0%.

⚠️ `-q`/`--quiet` ilə birləşəndə İKİ QAT aldadıcıdır - **uğur da sükutludur**. "Log dəyişmir" nə ilişmə, nə uğur sübutudur.

**Yoxlama:** worker prosesləri canlıdırmı (`ps aux | grep <executor>`), test-nəticə artefaktlarının `mtime`-ı irəliləyirmi.

**İlişəndə:** daemon-u öldür, sonra kiçik hədəflənmiş dəst (ad filtri + `--max-workers=1`) demək olar həmişə dərhal bitir. Tam dəst paralel iş olmadan, tək başına daha etibarlıdır.

## 4. e2e uğursuzluğu: yük-flake, spec qüsuru, yoxsa reqressiya?

Tam suite paralel işləyəndə (çoxlu brauzer + backend + frontend + build daemon eyni yaddaşda) **əlaqəsiz** spec random timeout verir. `retry=0` olanda bu "flaky" yox, "failed" kimi görünür.

Ardıcıllıq:
1. Uğursuz spec toxunduğun kodla əlaqəlidirmi? Yoxdursa → flake ehtimalı yüksəkdir.
2. Standalone qaçır. Təkbaşına təmiz keçirsə → yük-flake.
3. 🔴 **Dayanma:** iddianın hər cəhddə YENİDƏN OXUYUB-oxumadığına bax. Lokator əsaslı iddia (`toHaveAttribute`, `toHaveText`) DOM sorğusunu təkrarlayır, **səhifəni yenidən yükləmir** - yük altında bir pis render onu timeout boyu qırır. Bu, infra flake DEYİL, düzəldilməli spec qüsurudur. Repair həmişə eyni: re-query yox, **re-READ**.

Uğursuz specləri adbaad təkrar qaçırmaq dəqiqələrdir, tam suite onlarla dəqiqə - əvvəl ucuzunu et.

## 5. "Ağac dəyişdi / STALE" deyir

Əvvəl **kimin faylının** dəyişdiyinə bax (`git status` + fayl `mtime`-ları):

- Fayllar SƏNİN düzəlişindirsə → build addımını təkrar qaç və bil ki, review-lar da köhnəldi.
- Başqa bir sessiya və ya insan paralel işləyirsə fayllar ONUNKUDUR → sürətli `gate` cari ağacı örtür, tam sweep-i təkrar qaçırmağa ehtiyac yoxdur.

Generasiya olunan artefaktlar (OpenAPI JSON, snapshot, lock fayl) barmaq izindən çıxarılmalıdır - onları PCC-nin öz addımı yenidən yazır, mənbə dəyişikliyi deyil. Amma **PCC-nin qaçırmadığı** generatorun çıxışını çıxarma - onda real əl redaktəsi görünməz qalır.

## 6. Review skill-ləri git bazası tapmır

`/security-review`, `/simplify`, `/code-review` `origin/HEAD...` işlədir:
```bash
git remote set-head origin -a
```

## 7. Format/lint alətləri exit 0 ilə yalan danışır

`gofmt -l`, bəzi `prettier --check` variantları və oxşarları problem tapanda da exit 0 verir - sadəcə fayl adlarını stdout-a yazır. Qapı **çıxışın boş olmasını** tələb etməlidir, exit kodunu yox. Eyni sinif: heç bir test tapmayan qaçış da exit 0-dır - "0 test icra olundu" uğursuzluq sayılmalıdır.
