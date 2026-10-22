# security-workflows

appbrew の Organization rulesets から、全リポジトリに課す共通のセキュリティ workflow を置くリポジトリです。
各リポジトリに workflow ファイルを置く必要はありません。

ruleset から使えるように、このリポジトリは public にしています。
GitHub の仕様で、workflow を置くリポジトリの公開範囲は、使う側と同じか、それより広くなければならないためです。

## Betterleaks（`.github/workflows/betterleaks.yml`）

PR とマージキューで、その変更で増えたコミットに秘密情報（トークンやパスワード）が含まれていないかを検査します。
見つかるとジョブが失敗し、PR をマージできません。

### 検出されたとき

1. 本物の秘密情報なら、まずその値を無効にします（発行元でローテーションします）。コミットから消すだけでは足りません。push した時点で GitHub に届いているためです。
2. コミットから値を取り除き、PR を更新します。
3. 誤検知のときは、ジョブのログに出る `Fingerprint` の値を、そのリポジトリの直下の `.betterleaksignore` に1行で追記します。

### 設定

- 検査ルールは Betterleaks の既定のルールです。検査される側の `.betterleaks.toml` は読みません。PR が自分の検査ルールを弱められないようにするためです。
- 見つけた値が本物かを外部の API に問い合わせる機能（`--validation`）は使いません。
