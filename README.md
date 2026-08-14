# PCC - Pre Commit Check

Claude Code üçün commit qapısı protokolu. Stack-dən asılı deyil: JS, Java, Go, Rust, Python - fərq etmir, çünki əmrlər skill-də deyil, repo-nun öz adapterindədir.

> **Dil:** skill məzmunu azərbaycancadır.
> **Language:** the skill content is written in Azerbaijani.

## Nə edir

Claude "PCC" sözünü eşidəndə bu protokolu yükləyir:

- **İki tier.** `gate` hər commitdə (saniyələr), `sweep` gün sonunda (dəqiqələr). "PCC" tək başına deyiləndə default = sweep.
- **Pozulmaz sıra.** Build → servislər həqiqətən qalxır → düzəliş → review skill-ləri → testlər → təmiz build. Kod əvvəl oturur, review sonra, yoxsa hər düzəliş review-ları köhnəldir.
- **Sürət qaydası: dövrənin içində DAR, sonda BİR dəfə GENİŞ.** Qapı qırılanda səbəbkar faylı düzəlt və yalnız onu yenidən yoxla. Ara iterasiyada tam suite qaçırmaq xərcdir və heç nə sübut etmir.
- **Review skill-lərinə hər raundda yalnız o raundun deltası.** Ölçülmüş nümunə: yeddi raundluq sweep-də hər raund eyni 550 KB diffi yenidən oxudu, raund başına ~800 min token.
- **Kosmetik tapıntı dövrəni yenidən başlatmır.** Davranışı dəyişməyən tapıntı borca yazılır.
- **Sübut qaydaları.** Exit kodu sübut deyil (ölçülmüş: `gradlew build | tail` 63 uğursuz testlə exit 0 verdi). Artefaktı oxu - və artefakt TƏZƏ olmalıdır, çünki UP-TO-DATE build sistemi heç nə icra etmədən köhnə nəticəni "pass" kimi göstərir.
- **Uzun addımı düzgün qaçır.** `nohup … & disown` + `kill -0 $PID` döngəsi. Mətn sentineli nə baş verdiyini deyir, nə vaxt dayanmağı yox.

`troubleshooting.md` doqquz universal tələni saxlayır: reap olunmuş uzun qaçış, paralel sessiyanın artefaktı üstələməsi, sükutla ilişən test icraçısı, e2e yük-flake-i, STALE ağac, exit 0 ilə yalan danışan format alətləri.

**PCC heç vaxt commit etmir.** Yaşıl verdiktdən sonra dayanır və göstərişi gözləyir.

## Quraşdırma

### Plugin kimi (tövsiyə olunur)

```
/plugin marketplace add <owner>/claude-pcc
/plugin install pcc@claude-pcc
```

### Əl ilə (şəxsi)

```bash
git clone <repo-url>
mkdir -p ~/.claude/skills
cp -r claude-pcc/skills/pcc ~/.claude/skills/
```

### Repo daxilində (komanda)

`skills/pcc/` qovluğunu öz repo-nuzun `.claude/skills/pcc/` yoluna commit edin. İnstall addımı olmur, klonlayan hər kəs alır.

## İlk qaçış

Skill ilk işi olaraq `<repo>/.claude/pcc.md` adapterini axtarır. Yoxdursa stack-i özü müəyyənləşdirir və adapteri yazır - `examples/pcc.md` onun şablonudur.

Sonra sadəcə "PCC et" de.

## Tələblər

- Claude Code (`/security-review`, `/simplify`, `/code-review` built-in skill-lərindən istifadə edir - başqa custom skill asılılığı YOXDUR)
- git repo-su, `origin/HEAD` təyin olunmuş: `git remote set-head origin -a`

## Lisenziya

MIT
