#!/usr/bin/env bash
# 给打包产物签名。
#
# 钥匙串里有本地自签的代码签名证书就用它，没有就退回 ad-hoc。
# 为什么不一直 ad-hoc：macOS 的 TCC（辅助功能授权）与钥匙串「始终允许」都按代码签名认人，
# ad-hoc 每打一次包签名标识就变一次，用户每次重装都要重新勾一遍辅助功能、再点一次钥匙串。
# 用一张稳定的本地证书签，签名标识就不再随构建漂 —— 与 ContextIME 的 build_app.sh 同一个理由。
# 证书本身在用户的 login 钥匙串里（Keychain Access 自建的代码签名证书），仓库里没有任何私钥。
set -euo pipefail
app="${1:?用法: sign-app.sh <App 路径>}"
identity="${MONITOR_SIGN_IDENTITY:-ContextIME Local Signing Cert}"
if /usr/bin/security find-identity -v -p codesigning | grep -q "$identity"; then
  sign="$identity"
  echo "用本地证书签名：$identity"
else
  sign="-"
  echo "钥匙串里没有「$identity」，退回 ad-hoc 签名（每次重装要重新授权辅助功能与钥匙串）"
fi
codesign --force --deep --timestamp=none --sign "$sign" "$app"
codesign --verify --deep --strict "$app"
echo "签名完成：$(codesign -dv "$app" 2>&1 | grep -E '^(Identifier|Signature|Authority)=' | tr '\n' ' ')"
