if [ ! -f Taskfile.yml ] || [ ! -f transfer.yaml ]; then
  echo "source demo.sh from the demo project root" >&2
  return 1
fi

export DEMO_DIR="$PWD"

ocm() {
  docker run --rm \
    --network kind \
    --user "$(id -u):$(id -g)" \
    -v "$DEMO_DIR:$DEMO_DIR" \
    -w "$PWD" \
    -e TMPDIR="$DEMO_DIR/tmp" \
    ghcr.io/open-component-model/cli:0.21.0 "$@"
}

echo "ocm -> ghcr.io/open-component-model/cli:0.21.0 (kind network)"
