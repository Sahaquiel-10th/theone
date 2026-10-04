import { useEffect, useRef, useState } from "react";
import type { api as Api } from "./oneApi";
import { Pagination, SearchPicker, SettingsDialog } from "./SettingsControls";
import type {
  ExecutorValues,
  ExecutorProfile,
} from "../server/executorProfiles";
type Model = { id: string; name: string; kind: string; enabled: boolean };
type Row = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  version: number;
};
type Detail = ExecutorProfile & { total: number; defaults: ExecutorValues };
export function ExecutorPanel({
  api,
  models,
}: {
  api: typeof Api;
  models: Model[];
}) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [refresh, setRefresh] = useState(0),
    [list, setList] = useState<{
      items: Row[];
      total: number;
      defaults?: ExecutorValues;
    }>({ items: [], total: 0 }),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    void api<typeof list>(
      `/api/admin/executors?q=${encodeURIComponent(query)}&page=${page}`,
      { signal: c.signal },
    )
      .then((d) => {
        setList(d);
        setError("");
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [api, query, page, refresh]);
  return (
    <section>
      <header className="section-toolbar">
        <h3>事情执行器</h3>
        <button
          type="button"
          className="primary"
          disabled={!list.defaults}
          onClick={() => setSelected("new")}
        >
          ＋ 新增执行器
        </button>
      </header>
      <input
        aria-label="搜索执行器"
        placeholder="搜索执行器"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPage(1);
        }}
      />
      <p className="hint">
        默认使用上方的通用事情执行
        AI；专业执行器可选择不同模型、提示词和已认定功能。
      </p>
      <div className="settings-choice-list">
        {list.items.map((p) => (
          <button type="button" key={p.id} onClick={() => setSelected(p.id)}>
            <span>
              <strong>{p.name}</strong>
              <small>
                {p.description} ·{" "}
                {p.enabled
                  ? `已启用 v${p.version}`
                  : p.version
                    ? "已停用"
                    : "草稿"}
              </small>
            </span>
            <span>配置</span>
          </button>
        ))}
      </div>
      <Pagination page={page} total={list.total} onChange={setPage} />
      {error ? <p role="alert">{error}</p> : null}
      {selected && list.defaults ? (
        <SettingsDialog
          title={selected === "new" ? "新增执行器" : "配置执行器"}
          onClose={() => setSelected(null)}
        >
          <ExecutorEditor
            key={selected}
            api={api}
            id={selected}
            defaults={list.defaults}
            models={models}
            onChanged={(id) => {
              setRefresh((n) => n + 1);
              setSelected(id);
            }}
          />
        </SettingsDialog>
      ) : null}
    </section>
  );
}
function ExecutorEditor({
  api,
  id,
  defaults,
  models,
  onChanged,
}: {
  api: typeof Api;
  id: string;
  defaults: ExecutorValues;
  models: Model[];
  onChanged: (id: string) => void;
}) {
  const loaded = useRef(false);
  const [detail, setDetail] = useState<Detail>(),
    [values, setValues] = useState<ExecutorValues>(defaults),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [historyPage, setHistoryPage] = useState(1),
    [featureQuery, setFeatureQuery] = useState(""),
    [featurePage, setFeaturePage] = useState(1),
    [features, setFeatures] = useState<{
      items: { id: string; name: string; status: string }[];
      total: number;
    }>({ items: [], total: 0 });
  useEffect(() => {
    if (id === "new") return;
    const c = new AbortController();
    void api<Detail>(`/api/admin/executors/${id}?page=${historyPage}`, {
      signal: c.signal,
    })
      .then((d) => {
        setDetail(d);
        if (!loaded.current) { setValues(d.draft); loaded.current = true; }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [api, id, historyPage]);
  useEffect(() => {
    const c = new AbortController();
    void api<typeof features>(
      `/api/admin/official-features?q=${encodeURIComponent(featureQuery)}&page=${featurePage}`,
      { signal: c.signal },
    )
      .then(setFeatures)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [api, featureQuery, featurePage]);
  async function save(action: string, version?: number) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: string }>(
        `/api/admin/executors${id === "new" ? "" : `/${id}`}`,
        {
          method: "POST",
          body: JSON.stringify({
            revision: detail?.revision ?? 0,
            action,
            values,
            version,
          }),
        },
      );
      if (id === "new") onChanged(r.id);
      else {
        const d = await api<Detail>(`/api/admin/executors/${id}`);
        setDetail(d);
        setValues(d.draft);
        setHistoryPage(1);
        onChanged(id);
      }
      setError(
        action === "draft"
          ? "草稿已保存，尚未生效"
          : "配置已更新，仅新轮次使用新版本",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  const dirty =
    id === "new" ||
    !detail ||
    JSON.stringify(values) !== JSON.stringify(detail.draft);
  return (
    <div className="ai-task-editor">
      <fieldset disabled={busy || (id !== "new" && !detail)}>
        <label>
          名称
          <input
            maxLength={60}
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
          />
        </label>
        <label>
          适合处理什么
          <textarea
            rows={3}
            maxLength={1000}
            value={values.description}
            onChange={(e) =>
              setValues({ ...values, description: e.target.value })
            }
          />
        </label>
        <SearchPicker
          label="执行模型"
          value={values.modelId}
          options={[
            { value: "", label: "沿用该事情的模型" },
            ...models
              .filter((m) => m.enabled && m.kind === "chat")
              .map((m) => ({ value: m.id, label: m.name })),
          ]}
          onChange={(modelId) => setValues({ ...values, modelId })}
        />
        <label>
          提示词
          <textarea
            rows={10}
            style={{ width: "100%" }}
            maxLength={12000}
            value={values.prompt}
            onChange={(e) =>
              setValues({
                ...values,
                prompt: e.target.value,
                promptMode: "replace",
              })
            }
          />
        </label>
        <button
          type="button"
          onClick={() => {
            if (confirm("恢复通用提示词？保存发布后生效。"))
              setValues({ ...values, prompt: defaults.prompt });
          }}
        >
          恢复预制提示词
        </button>
        <h4>允许的工具</h4>
        {["knowledge_search", "web_search"].map((tool) => (
          <details key={tool}>
            <summary>
              {tool === "knowledge_search" ? "知识库检索" : "联网搜索"}
            </summary>
            <label>
              <input
                type="checkbox"
                checked={values.tools.includes(tool)}
                onChange={(e) =>
                  setValues({
                    ...values,
                    tools: e.target.checked
                      ? [...values.tools, tool]
                      : values.tools.filter((t) => t !== tool),
                  })
                }
              />
              允许使用
            </label>
            <label>
              调用条件
              <textarea
                rows={3}
                value={values.toolDescriptions?.[tool] ?? ""}
                onChange={(e) =>
                  setValues({
                    ...values,
                    toolDescriptions: {
                      ...values.toolDescriptions,
                      [tool]: e.target.value,
                    },
                  })
                }
              />
            </label>
          </details>
        ))}
        <details>
          <summary>绑定已认定功能 · {values.featureIds.length}</summary>
          <div aria-label="已绑定功能">{values.featureIds.map(id => <button type="button" key={id} onClick={() => setValues({...values,featureIds:values.featureIds.filter(selected => selected !== id)})}>{features.items.find(f => f.id === id)?.name ?? id} ×</button>)}</div>
          <input
            aria-label="搜索可绑定功能"
            value={featureQuery}
            onChange={(e) => {
              setFeatureQuery(e.target.value);
              setFeaturePage(1);
            }}
          />
          {features.items
            .filter((f) => f.status === "approved")
            .map((f) => (
              <label key={f.id}>
                <input
                  type="checkbox"
                  checked={values.featureIds.includes(f.id)}
                  disabled={
                    !values.featureIds.includes(f.id) &&
                    values.featureIds.length >= 8
                  }
                  onChange={(e) =>
                    setValues({
                      ...values,
                      featureIds: e.target.checked
                        ? [...values.featureIds, f.id]
                        : values.featureIds.filter((id) => id !== f.id),
                    })
                  }
                />
                {f.name}
              </label>
            ))}
          <Pagination
            page={featurePage}
            total={features.total}
            onChange={setFeaturePage}
          />
          <small>
            认定不等于授权；执行时仍须对使用者开放，外部数据使用需用户确认。
          </small>
        </details>
        <label>
          最大步骤
          <input
            type="number"
            min={1}
            max={4}
            value={values.maxSteps}
            onChange={(e) =>
              setValues({ ...values, maxSteps: Number(e.target.value) })
            }
          />
        </label>
        <div className="settings-pagination">
          <button type="button" onClick={() => void save("draft")}>
            保存草稿
          </button>
          {id !== "new" ? (
            <>
              <button
                type="button"
                disabled={dirty}
                onClick={() => {
                  if (confirm("发布并启用？只影响新的执行轮次。"))
                    void save("publish");
                }}
              >
                发布并启用
              </button>
              <button
                type="button"
                disabled={!detail?.enabled}
                onClick={() => {
                  if (confirm("停用后将阻止后续步骤，已产生的用量仍保留。"))
                    void save("pause");
                }}
              >
                停用
              </button>
            </>
          ) : null}
        </div>
      </fieldset>
      {error ? <p role="status">{error}</p> : null}
      {detail ? (
        <details>
          <summary>历史版本 · {detail.total}</summary>
          {detail.history.map((v) => (
            <details key={v.version}>
              <summary>
                v{v.version} · {new Date(v.publishedAt).toLocaleString()}
              </summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>
                {JSON.stringify(v, null, 2)}
              </pre>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (confirm("将此版本恢复为新发布版本？"))
                    void save("rollback", v.version);
                }}
              >
                恢复并发布
              </button>
            </details>
          ))}
          <Pagination
            page={historyPage}
            size={5}
            total={detail.total}
            onChange={setHistoryPage}
          />
        </details>
      ) : null}
    </div>
  );
}
