process-images:
	find content -iname "*.jpg" -or -iname "*.png" -exec exiftool -all= {} \;
	find static -iname "*.jpg" -or -iname "*.png" -exec exiftool -all= {} \;

spell-check:
	find content -iname "*.md" -exec pylanguagetool -m no -l en-US -t md {} \;
