MESSENGER UNLEASHED - Installation Instructions
===============================================

Since this app is not signed with an Apple Developer certificate,
macOS may block it from opening. Here's how to fix that:


OPTION 1: Right-click to open (easiest)
---------------------------------------
1. Drag "Messenger Unleashed" to your Applications folder
2. Open Applications in Finder
3. Right-click (or Control-click) on "Messenger Unleashed"
4. Click "Open" from the menu
5. Click "Open" again in the dialog that appears
6. The app will now open normally every time


OPTION 2: Terminal command
--------------------------
1. Drag "Messenger Unleashed" to your Applications folder
2. Open Terminal (Applications > Utilities > Terminal)
3. Run this command:

   xattr -cr /Applications/Messenger\ Unleashed.app

4. Open the app normally


OPTION 3: System Settings
-------------------------
1. Try to open the app (it will be blocked)
2. Open System Settings > Privacy & Security
3. Scroll down to find the message about Messenger Unleashed
4. Click "Open Anyway"


Why does this happen?
---------------------
Apple requires developers to pay $99/year for a certificate to sign
apps. Unsigned apps downloaded from the internet are blocked by
default. The methods above tell macOS you trust this app.

For more info: https://github.com/pcstyleorg/messenger-desktop
