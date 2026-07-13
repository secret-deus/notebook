---
title: "Nginx-alias-vs-root"
publish: true
---

# Nginx alias vs root 区别与坑点

## 核心区别

| | `root` | `alias` |
|---|---|---|
| **语义** | 文档根目录 | 路径别名 |
| **路径拼接** | `root` + `uri` | `alias` 替换 `location` 前缀 |
| **适用场景** | 文件在 location 路径的子目录 | location 前缀不在文件路径中 |

### alias 替换逻辑

```nginx
location /open/app {
    alias /www/dist/;
}
```

请求 `/open/app/index.html`：
- 去掉 location 前缀 `/open/app`，剩余 `/index.html`
- alias_path + 剩余 = `/www/dist/index.html`

### root 路径拼接

```nginx
location /open/app/ {
    root /www/dist/;
}
```

请求 `/open/app/index.html`：
- root + uri = `/www/dist/open/app/index.html`

---

## alias + try_files 的坑

### 错误写法

```nginx
location /open/app {
    alias /www/dist/open/app/;
    try_files $uri $uri/ /open/app/index.html =404;  # ❌ 回退路径不走 alias
}
```

当回退到 `/open/app/index.html` 时：
- alias **不参与回退路径解析**
- 路径相对于 server root（默认 `/usr/share/nginx/html`）解析
- 实际查找：`/usr/share/nginx/html/open/app/index.html` → **不存在 → 404**

### 正确写法

```nginx
location /open/app {
    alias /www/dist/open/app/;
    try_files $uri $uri/ =404;  # ✅ 让 $uri/ 自动找目录下的 index.html
}
```

---

## 场景选择

| 情况 | 配置 | 示例 |
|------|------|------|
| location 前缀 = 文件夹名 | `alias` | `location /app/` → `alias /www/dist/` |
| 文件在 location 的子目录 | `root` | `location /open/app/` → `root /www/dist/`（文件在 `/open/` 下） |
| try_files SPA 回退 | **必须用 `root`** | alias 回退路径解析会出错 |

---

## 典型目录结构示例

```
dist/
├── index.html         # /app 的入口
├── assets/
└── open/
    └── app/           # /open/app 的入口
        └── index.html
```

### 对应配置

```nginx
# /app — 内容直接在 dist/ 下
location /app {
    alias /home/wwwroot/fe/fe-pifi/dist/;
    try_files $uri $uri/ =404;
}

# /open/app — 内容在 dist/open/app/ 下
location /open/app {
    alias /home/wwwroot/fe/fe-pifi/dist/open/app/;
    try_files $uri $uri/ =404;
}
```

---

## 经验总结

1. **alias 路径必须和实际内容目录对齐**，不能省略中间路径
2. **try_files 回退不要写绝对路径**，用 `$uri/` 让 Nginx 自动找 index.html
3. **SPA（Vue/React）场景优先用 root**，配合 `/index.html` 回退
4. **区分清楚**：URL 路径 vs 文件系统路径，两者不一定一致

---

## 相关

- [[Nginx 配置踩坑记录]]
- [[Vue SPA 部署]]
