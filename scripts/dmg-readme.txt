ds_pet · 安装说明 / Install guide
==================================

ds_pet 基于开源项目 dsh-pet（PC2005-cloud，MIT）二次创作：
https://github.com/PC2005-cloud/dsh-pet
ds_pet is a remix of the open-source project dsh-pet by PC2005-cloud (MIT).

项目主页 / Project page: https://github.com/cjian1/ds_pet


【中文】
1. 把 ds_pet 图标拖到旁边的 Applications（应用程序）文件夹。
2. 打开「应用程序」，双击 ds_pet。

第一次打开被系统拦住？这个应用没有付费购买苹果开发者签名，macOS 第一次会提示
「无法验证开发者」。这是正常的，任选一种方法放行：

  方法一：在提示框里点「完成」（不要点「移到废纸篓」）→ 打开「系统设置 › 隐私与安全性」，
          往下翻，点「仍要打开」，输入开机密码确认 → 再双击一次 ds_pet。
  方法二（提示「已损坏」时用）：打开「终端」，粘贴下面这一行后回车，再双击 ds_pet：

      xattr -dr com.apple.quarantine /Applications/ds_pet.app

打开后：桌面上会出现她，菜单栏多一个小鲸鱼图标。第一次会弹出设置窗口，
填上 DeepSeek API Key（https://platform.deepseek.com/api_keys）就能聊天；
不填也能拖她、甩她、点播动作。


【English】
1. Drag the ds_pet icon into the Applications folder next to it.
2. Open Applications and double-click ds_pet.

Blocked the first time? The app isn't signed with a paid Apple developer ID, so macOS
asks once. Either of these works:

  Option 1: Click "Done" (not "Move to Trash") → open System Settings › Privacy & Security,
            scroll down and click "Open Anyway", confirm with your password → open ds_pet again.
  Option 2 (if it says the app is "damaged"): open Terminal, paste this line, press Return,
            then open ds_pet again:

      xattr -dr com.apple.quarantine /Applications/ds_pet.app

After that she appears on your desktop and a little whale shows up in the menu bar.
The first time, Settings opens so you can add a DeepSeek API key
(https://platform.deepseek.com/api_keys) to chat with her. Without a key you can still
drag her, fling her and play her animations.
