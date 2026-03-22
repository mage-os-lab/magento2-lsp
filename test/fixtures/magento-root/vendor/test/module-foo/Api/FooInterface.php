<?php

namespace Test\Foo\Api;

interface FooInterface
{
    public function save(): void;
    public function getName(): string;
    public function load(): self;
}
