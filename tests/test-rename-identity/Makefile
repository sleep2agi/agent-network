# PR-5 #146 rename family — 14-case Docker matrix
#
# Build once: `make build`
# Run all 14: `make all`
# Run one:   `make case-N` (1..14)
# Clean:     `make clean`

IMAGE := anet-pr5-rename:dev
ART   := /tmp/p-146-pr5-rename
CASES := 1 2 3 4 5 6 7 8 9 10 11 12 13 14

.PHONY: build all clean $(addprefix case-,$(CASES))

build:
	docker build -f tests/test-rename-identity/Dockerfile -t $(IMAGE) .

all:
	@mkdir -p $(ART)/all && chmod 0777 $(ART)/all
	docker run --rm -v $(ART)/all:/artifacts $(IMAGE)

$(addprefix case-,$(CASES)):
	@n=$(@:case-=%); mkdir -p $(ART)/case-$$n && chmod 0777 $(ART)/case-$$n
	docker run --rm -v $(ART)/case-$$n:/artifacts $(IMAGE) /harness/run-case.sh $$n

clean:
	rm -rf $(ART)
	docker rmi $(IMAGE) 2>/dev/null || true
