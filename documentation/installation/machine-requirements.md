---
nav_title: Machine requirements and models
nav_group: installation
nav_group_title: Installation
nav_group_order: 10
nav_order: 15
---
# Machine requirements and embedding choices

Windows and macOS use the same resource policy. Setup measures the host, the
installation and model filesystems, and the Docker daemon before choosing an
embedding recommendation. Docker's memory allocation and Linux storage are
separate from the host's RAM and physical disk.

## Minimum and recommended budgets

These are conservative product planning estimates for installation, including
OS/build headroom. They are not supplier-certified model requirements or a
guarantee that a large corpus will fit. Measurements are in GiB (1024³ bytes).
Host memory headroom means currently free RAM on Windows and estimated available
RAM on macOS, as explained below. The minimum and recommended budgets are the
same on both platforms.

| Embedding configuration; API fact extraction in every row | Host RAM min / recommended | Host memory headroom min / recommended | Free app disk min / recommended | Additional free model disk min / recommended |
| --- | --- | --- | --- | --- |
| OpenAI or Voyage API | 8 / 16 | 2 / 4 | 35 / 60 | 0 / 0 |
| Ollama `nomic-embed-text` | 12 / 16 | 3 / 5 | 35 / 60 | 2 / 4 |
| Ollama `qwen3-embedding:0.6b` | 16 / 24 | 4 / 6 | 35 / 60 | 4 / 6 |
| Ollama `qwen3-embedding:4b` | 24 / 32 | 6 / 10 | 35 / 60 | 8 / 12 |
| Ollama `qwen3-embedding:8b` | 48 / 64 | 12 / 16 | 35 / 60 | 16 / 24 |

On macOS, setup retains the original OS-reported free RAM measurement but uses
an **estimated available RAM** value for the headroom check:
`(Pages free + Pages speculative + Pages inactive) × page size`, from
`/usr/bin/vm_stat`. Its printed free count already excludes speculative pages;
adding those two counts does not count the same pages twice. See
[Apple's vm_stat implementation](https://github.com/apple-oss-distributions/system_cmds/blob/main/vm_stat/vm_stat.c#L125-L132).

Purgeable memory can overlap those page categories, so it is not added again.
Compressed, wired, and swapped memory are also excluded from the estimate.
Inactive pages may require compression or disk writeback before reuse; they are
not guaranteed to become immediately free. This application estimate is not
Activity Monitor's memory-pressure reading. Apple maintains inactive queues for
both anonymous and file-backed pages; see
[Apple's inactive-page handling](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_resident.c#L9324-L9356).
If the macOS probe fails or returns invalid counters, setup uses OS-reported
free RAM and displays a warning. These measurement changes do not lower any
minimum requirement.

All configurations need at least 2 logical CPUs (4 recommended), Docker Linux
containers with 4 GiB of memory (6 recommended), and 25 GiB free inside Docker
storage (40 recommended). Supported host architectures are x64 and arm64.
Prepare Node 24 LTS or Node 22.12+ in the Node 22 line, Git, and Docker Desktop;
Windows also needs Git Bash.

Application and model disk budgets are added when they share a filesystem.
When Docker data is on another physical disk, that disk must also meet its
25 / 40 GiB reserve. Docker's virtual disk maximum is not its current free
space. If that measurement or disk-image location is unavailable, setup says
so and asks you to check Docker Desktop before acknowledging the warning.

A computer with 8 GiB RAM can use API embeddings and API fact extraction if the
remaining requirements pass. Local embeddings are disabled at that memory tier.
The memory database, graph services, dashboard, and build still run locally;
API keys alone cannot compensate for insufficient base RAM or disk space.

## How setup makes a recommendation

The wizard selects the largest supported local model that meets its recommended
measured headroom. If none qualifies, it suggests OpenAI
`text-embedding-3-small`. This is this application's resource/value policy, not
a claim that it wins every retrieval benchmark.

Next stays blocked below any measured minimum. Acknowledging a warning cannot
override a minimum. Above minimum but below recommended headroom, setup explains
the risk and requires acknowledgement. An oversized local model is strongly
discouraged: memory pressure may freeze the machine or force processes to stop,
and interrupted writes may damage files or an installation. Low RAM itself is
not evidence of corrupted hardware memory.

Close memory-heavy applications, free the stated disk space or expand Docker's
storage, then choose **Check resources again**. Every recheck clears the previous
acknowledgement. Installation and local model tests/pulls recheck resources on
the server so an old browser result cannot bypass a current minimum failure.

## API model choices

| Provider and model | Default dimensions | Choose it for |
| --- | --- | --- |
| **OpenAI `text-embedding-3-small` — recommended for value** | 1536 | Lower API cost and vector storage; the default API choice for this application |
| OpenAI `text-embedding-3-large` | 3072 | Higher retrieval quality within OpenAI's embedding family, at higher cost/storage |
| **Voyage `voyage-4` — recommended within Voyage** | 1024 | Balanced general and multilingual retrieval |
| Voyage `voyage-4-large` | 1024 | Highest retrieval quality in the Voyage 4 family |
| Voyage `voyage-4-lite` | 1024 | Lower latency and cost in the Voyage 4 family |

OpenAI's official guide documents both models, their dimensions, and the
cost/quality trade-off. See [OpenAI embeddings](https://developers.openai.com/api/docs/guides/embeddings).
Anthropic does not offer embeddings and points developers to Voyage. See
[Anthropic's embedding guidance](https://platform.claude.com/docs/en/build-with-claude/embeddings)
and [Voyage's current model catalog](https://docs.voyageai.com/docs/embeddings).
Model guidance was checked on 7 September 2026; recommendations above are not a
benchmark of this application's memories across providers.

Choose an embedding provider independently of the extraction provider. A Claude
API key cannot authenticate a Voyage embedding request. The same OpenAI key can
be used for OpenAI embeddings and extraction. Keys stay in the local gitignored
environment file and are masked in review. Remote requests transmit memory and
search text to the embedding provider and require internet access and provider
billing. The connection test sends only a short synthetic sample; it validates
the response dimensions as well as access, and may incur a small charge.

Changing the model, provider, or dimensions after storing memories requires the
dashboard's re-embedding migration. Setup preserves an installed corpus. A
failed first installation with a proven empty database can switch configuration
on retry; an unreadable old database must be recovered before changing its pin.

## OpenAI embedding access troubleshooting

An enabled model in an OpenAI project's model allowlist does not by itself
authorize an API key to call embeddings. Check the project that issued the key,
the selected embedding model, and the key's permissions. The key's user or
service account must also have the necessary access in that project.

For `/v1/embeddings`, check **Model capabilities → Request** (`model.request`,
also documented as `api.model.request`). Listing models or enabling only
Responses access is not sufficient. Use a project key with the permissions the
application needs; an unrestricted administrator key is unnecessary. Role
changes can take up to 30 minutes to propagate. See
[OpenAI's permission guide](https://developers.openai.com/api/docs/guides/rbac).

Use the test's error details rather than treating every HTTP 403 as a permission
failure:

| Reported failure | What to check |
| --- | --- |
| Missing permission or model access | The selected model's project allowlist, the key's project and request permissions, and the user's or service account's project access |
| HTTP 401: invalid authentication | Whether the local key is correct, current, and belongs to the intended project/organization |
| HTTP 401: IP not authorized | The machine's outgoing IP against the project's or organization's IP allowlist |
| HTTP 403: unsupported country or region | Whether API access is supported from the request's location |
| HTTP 429: credits, spend, or usage limit | The specific error code and the project's/organization's billing or limits; repeated retries do not replenish credits |
| HTTP 429: request rate limit | Reduce request frequency and follow any retry delay |

See [OpenAI's error-code guide](https://developers.openai.com/api/docs/guides/error-codes)
for the corresponding codes and remedies. After correcting the identified
cause, retry **Test embedding connection** with the intended model and key.
Never share API keys or include them in screenshots, logs, or support messages.
For diagnosis, provide only the selected model, HTTP status, sanitized error
code, and request ID when available.

## Interrupted installs and cleanup

The installer builds images one at a time and runs isolated runtime/compiled
module checks before starting the stack. A failed image check triggers at most
one targeted rebuild without cache or a pull of that image. Disk-full and
storage I/O failures stop the process with recovery instructions; rebuilding an
image does not repair Docker's data disk or a damaged database.

Retries track immutable image IDs and temporary artifacts owned by this
installation. Cleanup removes unused owned artifacts after installation; images
referenced by any container and persistent data volumes are protected. Shared
base images and BuildKit cache whose ownership cannot be proved are retained.
There is no global Docker prune. The uninstaller separately asks whether to
keep or remove user data; see [uninstall and export](uninstall-memory-stack.md).
