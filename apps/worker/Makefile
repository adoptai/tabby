.PHONY: explore

explore:
	npx playwright codegen --channel chrome $(filter-out $@,$(MAKECMDGOALS))

# Swallow extra args so make doesn't treat the URL as a target
%:
	@:
