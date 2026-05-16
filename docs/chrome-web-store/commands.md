# SWIS Screenshot Resizing

## Resize a window

wmctrl -r "WindowName" -e 0,0,0,1280,800
wmctrl -r "WindowName" -e 0,0,0,1279,916   # Adjusted for widgets
wmctrl -r "WindowName" -e 0,0,0,2559,1716  # Double size

## Resize images to 1280x800

```bash
for file in 1 2 3 4; do
  convert "SWIS-ss${n}.png" -resize 1280x800 "SWIS-ss${n}-1280x800.png"
done
```

## Add a 1px black border

Expanding the canvas (output becomes 1282x802):

```bash
convert SWIS-ss2-1280x800.png -bordercolor black -border 1 SWIS-ss2-1280x800-bordered.png
```

Keeping the original dimensions (1280x800, shaves 1px before bordering):

```bash
convert SWIS-ss2-1280x800.png -shave 1x1 -bordercolor black -border 1 SWIS-ss2-1280x800-bordered.png
```

## Check dimensions

```bash
identify SWIS-ss2-1280x800-bordered.png
```
