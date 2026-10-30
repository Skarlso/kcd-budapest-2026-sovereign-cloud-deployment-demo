# Running this demo

There are multiple ways to run this demo.

## Using Tasks

Once on stage, start by running `task online`. This will download and set up everything and use ocm add cv and ocm transfer
in the background to fetch and load up the components.

Then, disable wifi and run `task deploy`. This will start everything.

Once deploy finishes, navigate to the URL, play the game, save the score.

Now, run `task upgrade`. This will deploy a new version of the game. Show the new version, play around, and show that the previous version is still there.

Once, done run `task clean`. If you are just testing, run `task reset` to not delete everything but reset the controllers and the objects.

## By hand

```bash
source demo.sh
```

### Wifi on: transfer

```bash
# the component constructor
cat components/game/component-constructor.yaml

# product -> game + postgres, with their resources
ocm get cv ./tmp/ctf//github.com/skarlso/kcd-budapest/product:1.0.0 -o widetree --recursive

# the image still points at ghcr
ocm get cv ./tmp/ctf//github.com/skarlso/kcd-budapest/game:1.0.0 -o json | jq '.[0].component.resources[] | {name, access}'

# transfer policy / settings
cat transfer.yaml
ocm transfer cv --config transfer.yaml --recursive ./tmp/ctf//github.com/skarlso/kcd-budapest/product:1.0.0 ./tmp/airgap-ctf

# the image is now a LocalBlob inside the archive, meaning it lives with the CTF
ocm get cv ./tmp/airgap-ctf//github.com/skarlso/kcd-budapest/game:1.0.0 -o json | jq '.[0].component.resources[] | {name, access}'
```

### WiFi off: deploy

```bash
ocm transfer cv --config transfer.yaml --recursive ./tmp/airgap-ctf//github.com/skarlso/kcd-budapest/product:1.0.0 http://registry:5000
```

### ORAS to verify and view what got transferred

```bash
oras repo ls --plain-http localhost:5001

# descriptor + resources
oras manifest fetch --plain-http localhost:5001/component-descriptors/github.com/skarlso/kcd-budapest/game:1.0.0 \
  | jq '.manifests[] | {artifactType, digest, resource: .annotations["software.ocm.artifact"]}'

# this is the full multie-arch image index
oras manifest fetch --plain-http localhost:5001/component-descriptors/github.com/skarlso/kcd-budapest/game@<image digest from above> | jq
```

### Upgrade

```bash
task cluster:bootstrap   # the import above already ran, so skip `task deploy`
task status              # pods run registry:5000/... images
task upgrade
```
