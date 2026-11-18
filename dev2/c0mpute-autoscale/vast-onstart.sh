#!/bin/bash
# c0mpute GPU worker on a rented Vast.ai card, for a REPLACEMENT instance rented by
# `c0mpute autoscale` (riotcoder 2026-11-18). Same as the original box's /root/onstart.sh
# + /root/c0mpute/start-gpu.sh, plus: the node identity comes in $C0MPUTE_IDENTITY_KEY_B64
# so the replacement keeps node id sdNT3kCN.
mkdir -p /root/c0mpute /home/c0mpute/.config/c0mpute
id c0mpute >/dev/null 2>&1 || useradd -m -s /bin/bash c0mpute
if [ -n "$C0MPUTE_IDENTITY_KEY_B64" ] && [ ! -s /home/c0mpute/.config/c0mpute/identity.key ]; then
  umask 077; echo "$C0MPUTE_IDENTITY_KEY_B64" | base64 -d > /home/c0mpute/.config/c0mpute/identity.key
  chown -R c0mpute:c0mpute /home/c0mpute/.config; chmod 600 /home/c0mpute/.config/c0mpute/identity.key
fi
cat > /root/c0mpute/start-gpu.sh <<'START_GPU'
#!/bin/bash
# c0mpute GPU worker + Ollama (CUDA) on the rented Vast 3060. Re-run safely; called from onstart.
# 2026-11-18: both models must stay resident in 12 GB or Ollama evicts/reloads on every switch
# (jobs then time out and Infernet hands them to CPU nodes). So: q8 KV + flash attention,
# never unload; NUM_PARALLEL=2 matches the worker (inference.rs MAX_CONCURRENT=2, 300 s timeout incl. queue), and the 9B re-tagged to 16k ctx (its Modelfile says 65536 = 13.6 GiB).
E="env HOME=/home/c0mpute OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=/home/c0mpute/.ollama/models OLLAMA_KEEP_ALIVE=-1 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=2"
NINE=eriktonon/qwen3.8-uncensored:9b
command -v ollama >/dev/null || { command -v zstd >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zstd >/dev/null; }; curl -fsSL https://ollama.com/install.sh -o /root/c0mpute/ollama-install.sh && sh /root/c0mpute/ollama-install.sh; }
mkdir -p /home/c0mpute/.ollama && chown -R c0mpute:c0mpute /home/c0mpute/.ollama
if [ "$1" = "--restart-ollama" ]; then pkill -u c0mpute -x ollama; sleep 3; fi
pgrep -u c0mpute -x ollama >/dev/null || runuser -u c0mpute -- $E nohup ollama serve >> /home/c0mpute/ollama.log 2>&1 &
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:11434/api/version && break; sleep 2; done
for m in $NINE; do runuser -u c0mpute -- $E ollama pull "$m" >/dev/null 2>&1; done
# a pull restores the upstream 65536 ctx; re-tag it to 32k under the same name
runuser -u c0mpute -- $E ollama show --modelfile $NINE | sed 's/^PARAMETER num_ctx .*/PARAMETER num_ctx 32768/' > /home/c0mpute/nine.Modelfile
grep -q '^PARAMETER num_ctx' /home/c0mpute/nine.Modelfile || echo 'PARAMETER num_ctx 32768' >> /home/c0mpute/nine.Modelfile
runuser -u c0mpute -- $E ollama create $NINE -f /home/c0mpute/nine.Modelfile >/dev/null 2>&1
# warm both so the first jobs don't pay the load
for m in $NINE; do curl -s -o /dev/null http://127.0.0.1:11434/api/generate -d "{\"model\":\"$m\",\"prompt\":\"hi\",\"stream\":false,\"options\":{\"num_predict\":1}}"; done
if [ "$1" != "--restart-ollama" ] || ! pgrep -u c0mpute -f "c0mpute worker" >/dev/null; then
pkill -u c0mpute -f "c0mpute worker" || true; sleep 2
runuser -u c0mpute -- env HOME=/home/c0mpute PATH=/home/c0mpute/bin:/usr/local/bin:/usr/bin:/bin C0MPUTE_NAME=profullstack C0MPUTE_REF=profullstack C0MPUTE_INFERENCE_AUTO=0 C0MPUTE_INFERENCE_URL=http://127.0.0.1:11434 C0MPUTE_STORAGE_MIN_FREE_GB=4 nohup /home/c0mpute/bin/c0mpute worker start --roles inference,music,diffusion,tts --no-storage --no-hosting >> /home/c0mpute/worker.log 2>&1 &
fi
echo "== $(date -u +%FT%TZ) gpu worker started (inference via ollama, 9B only, qwen2.5:7b off)"
START_GPU
chmod +x /root/c0mpute/start-gpu.sh
# c0mpute GPU worker on a rented Vast.ai card (riotcoder 2026-11-18). Logs: /root/c0mpute/*.log
mkdir -p /root/c0mpute && cd /root/c0mpute
exec >> /root/c0mpute/boot.log 2>&1
echo "== $(date -u +%FT%TZ) boot"; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
command -v curl >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates procps >/dev/null; }
id c0mpute >/dev/null 2>&1 || useradd -m -s /bin/bash c0mpute
mkdir -p /home/c0mpute/bin
if [ ! -x /home/c0mpute/bin/c0mpute ]; then
  curl -fsSL https://github.com/profullstack/c0mpute/releases/latest/download/c0mpute-linux-x86_64.tar.gz -o /tmp/c.tgz && tar -xzf /tmp/c.tgz -C /home/c0mpute/bin c0mpute
fi
chown -R c0mpute:c0mpute /home/c0mpute
/home/c0mpute/bin/c0mpute --version
pkill -u c0mpute -f "c0mpute worker" || true
/root/c0mpute/start-gpu.sh  # Ollama (CUDA) + worker with inference, 2026-11-18
