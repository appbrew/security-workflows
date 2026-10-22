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
3. 誤検知のときは、そのリポジトリの直下の `.betterleaksignore` に、次の形式で1行を追記します。値はジョブのログから取ります（ルール名は枠の左上、行番号は枠内の左端、コミットは `git.sha`、ファイルは `path`）。

   ```text
   <コミットのSHA>:<ファイルのパス>:<ルール名>:<行番号>
   ```

   例: `d16c50bbde90264d6f4a695763d67a74f330770f:config/example.env:github-pat:1`

### 設定

- 検査ルールは Betterleaks の既定のルールです。検査される側の `.betterleaks.toml` は読みません。PR が自分の検査ルールを弱められないようにするためです。
- 見つけた値が本物かを外部の API に問い合わせる機能（`--validation`）は使いません。
