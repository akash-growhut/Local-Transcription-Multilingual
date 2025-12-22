# Resources Directory

This directory contains the BlackHole audio driver for packaging with the Electron app.

## Using a Local BlackHole Package File

If you have `BlackHole2ch-0.6.1.pkg` locally, you can use it in several ways:

### Option 1: Place in resources directory

```bash
# Copy your local pkg file here
cp /path/to/BlackHole2ch-0.6.1.pkg resources/
npm run download-blackhole
```

### Option 2: Use command line argument

```bash
npm run download-blackhole -- /path/to/BlackHole2ch-0.6.1.pkg
```

### Option 3: Use environment variable

```bash
BLACKHOLE_PKG_PATH=/path/to/BlackHole2ch-0.6.1.pkg npm run download-blackhole
```

### Option 4: Place in project root

```bash
# Place BlackHole2ch-0.6.1.pkg in the project root directory
npm run download-blackhole
```

## Automatic Download

If no local file is found, the script will automatically download BlackHole 2ch 0.6.1 from GitHub.

## Output

After running the script, you'll have:

- `resources/BlackHole.driver` - The extracted driver (ready for packaging)
