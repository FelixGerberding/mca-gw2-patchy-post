# fonts

| File | Face | Used for |
| --- | --- | --- |
| `regular.ttf` | Selawik Regular | record times in the alltimes column, subtitle |
| `bold.ttf` | Selawik Bold | title, team names, ranks, boss names |
| `italic.ttf` | *(none - see below)* | optional |

The design was drawn in **Segoe UI**, which ships with Windows and is licensed
with it - fine to use on your own machine, not fine to commit.

Shipped here instead is **[Selawik](https://github.com/microsoft/Selawik)**,
Microsoft's own open, metric-compatible substitute for Segoe UI, under the SIL
Open Font License 1.1 (`OFL.txt`). Side by side with an old post the difference
is hard to spot.

## The italic

Selawik has no italic face, and canvas does **not** synthesise one - asking for
`italic` silently renders upright. The subtitle is italic in every post so far,
so `fillTextOblique()` in `index.js` shears it by hand instead.

If you drop a real `italic.ttf` in here it gets registered, but the subtitle
still goes through the shear - remove that call if you want the true italic.

## Using Segoe UI instead

Copy `segoeui.ttf` and `segoeuib.ttf` off a Windows install to `regular.ttf`
and `bold.ttf`. Everything else stays as it is. Keep them out of a public repo.
