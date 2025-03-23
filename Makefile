start-hugo:
	hugo server --buildDrafts --disableFastRender -F

install-pylanguagetools:
	pip install pylanguagetool@0.10.0

process-images:
	find content -iname "*.jpg" -or -iname "*.png" -exec exiftool -all= {} \;
	find static -iname "*.jpg" -or -iname "*.png" -exec exiftool -all= {} \;

spell-check:
	hugo --buildDrafts -F -D --cleanDestinationDir
	find public/posts -iname "*.html" -exec pylanguagetool -m no -l en-US --pwl pwl.txt -t html {} \;
	pylanguagetool -m no -l en-US --pwl pwl.txt -t html public/posts/index.html
